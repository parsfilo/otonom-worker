import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { Finalizer, FinalizerConfig } from "../../harness/finalizer/finalizer.js"

describe("Finalizer", () => {
  let tempDir: string
  let taskPath: string
  let resultPath: string
  let baseSha: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "finalizer-test-"))
    taskPath = path.join(tempDir, "task.json")
    resultPath = path.join(tempDir, "result.json")

    execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: tempDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir, stdio: "ignore" })

    fs.mkdirSync(path.join(tempDir, "src", "webhooks"), { recursive: true })
    fs.writeFileSync(path.join(tempDir, "src", "webhooks", "replay.ts"), "export const replay = true;\n")
    execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "init"], { cwd: tempDir, stdio: "ignore" })
    baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempDir, encoding: "utf-8" }).trim()

    fs.appendFileSync(path.join(tempDir, "src", "webhooks", "replay.ts"), "// edit\n")

    const task = {
      id: "webhook-durability",
      title: "Webhook durability",
      role: "builder-core",
      source_repository: "oaslananka/otonom",
      base_sha: baseSha,
      objectives: ["Add webhook replay log"],
      allowed_write_paths: ["src/webhooks/**"],
      forbidden_write_paths: [],
      acceptance_criteria: ["Tests pass"],
      verification_profile: "lane",
      risk_classification: "LOW"
    }

    const result = {
      task_id: "webhook-durability",
      lane: "webhook-durability",
      base_sha: baseSha,
      status: "PASS",
      model_used: "free-model-zen-flash",
      changed_paths: ["src/webhooks/replay.ts"],
      verification_results: [
        {
          profile: "lane",
          command: "node -e 'process.exit(0)'",
          exit_code: 0,
          passed: true,
          duration_ms: 100
        }
      ],
      test_summary: { total: 5, passed: 5, failed: 0, skipped: 0 },
      policy_violations: [],
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

    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2))
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2))
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it("dry-run mode validates successfully without pushing", async () => {
    const config: FinalizerConfig = {
      taskPath,
      resultPath,
      workspaceRoot: tempDir,
      dryRun: true,
      workflowRunId: "987654",
      customVerificationProfiles: {
        lane: "node -e 'process.exit(0)'"
      }
    }

    const finalizer = new Finalizer(config)
    const report = await finalizer.execute()

    expect(report.success).toBe(true)
    expect(report.dryRun).toBe(true)
    expect(report.pushed).toBe(false)
    expect(report.branchName).toBe("swarm/987654/webhook-durability")
  })

  it("refuses result with ownership violation", async () => {
    // Create an unauthorized file in Git
    fs.mkdirSync(path.join(tempDir, "src", "secrets"), { recursive: true })
    fs.writeFileSync(path.join(tempDir, "src", "secrets", "auth.ts"), "export const secret = 123;\n")

    const raw = JSON.parse(fs.readFileSync(resultPath, "utf-8"))
    raw.changed_paths = ["src/webhooks/replay.ts", "src/secrets/auth.ts"]
    fs.writeFileSync(resultPath, JSON.stringify(raw, null, 2))

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: tempDir,
      dryRun: true,
      workflowRunId: "987654",
      customVerificationProfiles: {
        lane: "node -e 'process.exit(0)'"
      }
    })

    const report = await finalizer.execute()
    expect(report.success).toBe(false)
    expect(report.error).toMatch(/Ownership violation/)
  })

  it("refuses invalid or failing result", async () => {
    const raw = JSON.parse(fs.readFileSync(resultPath, "utf-8"))
    raw.status = "FAIL"
    fs.writeFileSync(resultPath, JSON.stringify(raw, null, 2))

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: tempDir,
      dryRun: true,
      workflowRunId: "987654"
    })

    const report = await finalizer.execute()
    expect(report.success).toBe(false)
    expect(report.error).toMatch(/Result status is not PASS/)
  })

  it("formats deterministic branch name safely", () => {
    const branch = Finalizer.formatBranchName("12345", "lane/with/slashes--and_special")
    expect(branch).toBe("swarm/12345/lane-with-slashes--and-special")
  })

  it("formats sanitized PR body with metadata only, no raw diff/code", () => {
    const task = JSON.parse(fs.readFileSync(taskPath, "utf-8"))
    const result = JSON.parse(fs.readFileSync(resultPath, "utf-8"))
    const prBody = Finalizer.formatPrBody(task, result)

    expect(prBody).toContain("## Swarm Lane Execution: webhook-durability")
    expect(prBody).toContain("- **Task ID:** webhook-durability")
    expect(prBody).toContain(`- **Base SHA:** \`${baseSha}\``)
    expect(prBody).toContain("- **Status:** PASS")
    expect(prBody).toContain("- **Tests Passed:** 5")
    expect(prBody).not.toContain("diff --git")
    expect(prBody).not.toContain("proprietary")
    expect(prBody).not.toContain("secret")
  })
})
