import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { Finalizer } from "../../harness/finalizer/finalizer.js"

describe("Trusted Finalizer Verification & Acceptance", () => {
  let tempDir: string
  let repoDir: string
  let controlDir: string
  let baseSha: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "finalizer-verif-"))
    repoDir = path.join(tempDir, "target-repo")
    controlDir = path.join(tempDir, "harness-control")
    fs.mkdirSync(repoDir, { recursive: true })
    fs.mkdirSync(controlDir, { recursive: true })

    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" })

    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true })
    fs.writeFileSync(path.join(repoDir, "src", "code.ts"), "export const a = 1;\n")
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "ignore" })
    baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf-8" }).trim()
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function createTask(verificationProfile = "lane", customProfiles?: Record<string, string>) {
    const taskPath = path.join(controlDir, "task.json")
    const task = {
      id: "lane-verif-test",
      title: "Verification Lane",
      role: "builder-core",
      source_repository: "oaslananka/otonom",
      base_sha: baseSha,
      objectives: ["Pass tests"],
      allowed_write_paths: ["src/**"],
      acceptance_criteria: ["Pass all unit tests"],
      verification_profile: verificationProfile,
      risk_classification: "LOW"
    }
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2))
    return { taskPath, customProfiles }
  }

  function createResult(status = "PASS", claimedExitCode = 0, claimedPassed = true) {
    const resultPath = path.join(controlDir, "result.json")
    const result = {
      task_id: "lane-verif-test",
      lane: "lane-verif-test",
      base_sha: baseSha,
      status,
      model_used: "zen:gemini-2.5-flash",
      changed_paths: ["src/code.ts"],
      policy_violations: [],
      test_summary: { total: 1, passed: claimedPassed ? 1 : 0, failed: claimedPassed ? 0 : 1, skipped: 0 },
      verification_results: [
        {
          profile: "lane",
          command: "npm test",
          exit_code: claimedExitCode,
          passed: claimedPassed,
          duration_ms: 50
        }
      ],
      findings_fixed: [],
      remaining_blockers: [],
      cross_lane_request_count: 0,
      loop_metrics: {
        tool_repeats: 0,
        file_rereads: 0,
        stall_warnings: 0,
        diff_hash_changes: 1
      },
      completed_at: new Date().toISOString()
    }
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2))
    return resultPath
  }

  it("Test 1: forged PASS result + failing actual command is rejected by finalizer", async () => {
    // Valid git modification
    fs.appendFileSync(path.join(repoDir, "src", "code.ts"), "// edit\n")

    // Task specifies profile whose command actually exits 1
    const { taskPath } = createTask("lane")
    const resultPath = createResult("PASS", 0, true) // Agent forged PASS!

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: repoDir,
      dryRun: true,
      customVerificationProfiles: {
        lane: "node -e 'process.exit(1)'" // Real command fails!
      }
    })

    const report = await finalizer.execute()
    expect(report.success).toBe(false)
    expect(report.error).toMatch(/(Independent verification failed|exit code 1)/i)
    expect(report.trustedVerification?.passed).toBe(false)
  })

  it("Test 2: actual passing verification is accepted and trusted report is generated", async () => {
    fs.appendFileSync(path.join(repoDir, "src", "code.ts"), "// valid edit\n")

    const { taskPath } = createTask("lane")
    const resultPath = createResult("PASS", 0, true)

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: repoDir,
      dryRun: true,
      reportOutputPath: path.join(controlDir, "finalizer-report.json"),
      customVerificationProfiles: {
        lane: "node -e 'process.exit(0)'" // Real command passes!
      }
    })

    const report = await finalizer.execute()
    expect(report.success).toBe(true)
    expect(report.error).toBeUndefined()
    expect(report.trustedVerification?.passed).toBe(true)

    // finalizer-report.json must be written and contain trusted data
    const reportFile = path.join(controlDir, "finalizer-report.json")
    expect(fs.existsSync(reportFile)).toBe(true)
    const reportJson = JSON.parse(fs.readFileSync(reportFile, "utf-8"))
    expect(reportJson.success).toBe(true)
    expect(reportJson.trustedVerification.passed).toBe(true)
  })

  it("Test 3: verification timeout is rejected", async () => {
    fs.appendFileSync(path.join(repoDir, "src", "code.ts"), "// edit\n")

    const { taskPath } = createTask("lane")
    const resultPath = createResult("PASS", 0, true)

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: repoDir,
      dryRun: true,
      verificationTimeoutMs: 300,
      customVerificationProfiles: {
        // Sleep command that times out
        lane: process.platform === "win32"
          ? "powershell -Command Start-Sleep -Seconds 5"
          : "sleep 5"
      }
    })

    const report = await finalizer.execute()
    expect(report.success).toBe(false)
    expect(report.error).toMatch(/(timed out|timeout|failed)/i)
  })

  it("Test 4: agent says FAIL but trusted verification passes -> preserves truthful status", async () => {
    fs.appendFileSync(path.join(repoDir, "src", "code.ts"), "// edit\n")

    const { taskPath } = createTask("lane")
    const resultPath = createResult("FAIL", 1, false) // Agent says FAIL

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: repoDir,
      dryRun: true,
      customVerificationProfiles: {
        lane: "node -e 'process.exit(0)'"
      }
    })

    const report = await finalizer.execute()
    expect(report.success).toBe(false)
    expect(report.error).toMatch(/Result status is not PASS/i)
  })
})
