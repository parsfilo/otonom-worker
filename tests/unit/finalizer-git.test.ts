import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { GitChangeDetector } from "../../harness/finalizer/git-detector.js"
import { Finalizer } from "../../harness/finalizer/finalizer.js"

describe("Authoritative Git Change Detection in Finalizer", () => {
  let tempDir: string
  let repoDir: string
  let controlDir: string
  let baseSha: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-detector-test-"))
    repoDir = path.join(tempDir, "target-repo")
    controlDir = path.join(tempDir, "harness-control")
    fs.mkdirSync(repoDir, { recursive: true })
    fs.mkdirSync(controlDir, { recursive: true })

    // Initialize git repository with initial commit
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" })

    // Create initial structure
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true })
    fs.mkdirSync(path.join(repoDir, "forbidden"), { recursive: true })
    fs.writeFileSync(path.join(repoDir, "src", "allowed.ts"), "export const ok = 1;\n")
    fs.writeFileSync(path.join(repoDir, "forbidden", "secret.ts"), "export const secret = 42;\n")

    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repoDir, stdio: "ignore" })
    baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf-8" }).trim()
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function createTaskManifest(allowedWritePaths = ["src/**"], forbiddenWritePaths = ["forbidden/**", ".github/**"]) {
    const taskPath = path.join(controlDir, "task.json")
    const task = {
      id: "lane-git-test",
      title: "Test Lane",
      role: "builder-core",
      source_repository: "oaslananka/otonom",
      base_sha: baseSha,
      objectives: ["Modify allowed code"],
      allowed_write_paths: allowedWritePaths,
      forbidden_write_paths: forbiddenWritePaths,
      acceptance_criteria: ["Pass tests"],
      verification_profile: "targeted",
      risk_classification: "LOW"
    }
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2))
    return taskPath
  }

  function createResultManifest(changedPaths: string[], status = "PASS") {
    const resultPath = path.join(controlDir, "result.json")
    const result = {
      task_id: "lane-git-test",
      lane: "lane-git-test",
      base_sha: baseSha,
      status,
      model_used: "zen:gemini-2.5-flash",
      changed_paths: changedPaths,
      policy_violations: [],
      test_summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
      verification_results: [
        {
          profile: "targeted",
          command: "node -e 'process.exit(0)'",
          exit_code: 0,
          passed: true,
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

  it("Scenario 1: agent lies by omitting forbidden changed file", async () => {
    // Agent modifies allowed.ts AND forbidden/secret.ts
    fs.appendFileSync(path.join(repoDir, "src", "allowed.ts"), "// modification\n")
    fs.appendFileSync(path.join(repoDir, "forbidden", "secret.ts"), "// ILLEGAL CHANGE\n")

    const taskPath = createTaskManifest()
    // Agent deceptively omits forbidden/secret.ts from result.json!
    const resultPath = createResultManifest(["src/allowed.ts"])

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: repoDir,
      dryRun: true
    })

    const report = await finalizer.execute()
    expect(report.success).toBe(false)
    expect(report.error).toMatch(/(forbidden\/secret\.ts|Unreported changed file|Ownership violation)/i)
  })

  it("Scenario 2: untracked forbidden file is detected and rejected", async () => {
    fs.appendFileSync(path.join(repoDir, "src", "allowed.ts"), "// legit edit\n")
    // Agent creates an untracked forbidden file
    fs.writeFileSync(path.join(repoDir, "forbidden", "untracked-backdoor.ts"), "// backdoor\n")

    const taskPath = createTaskManifest()
    const resultPath = createResultManifest(["src/allowed.ts"])

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: repoDir,
      dryRun: true
    })

    const report = await finalizer.execute()
    expect(report.success).toBe(false)
    expect(report.error).toMatch(/(untracked-backdoor\.ts|Ownership violation|Unreported changed file)/i)
  })

  it("Scenario 3: rename allowed -> forbidden is rejected", async () => {
    // Rename src/allowed.ts to forbidden/moved.ts
    execFileSync("git", ["mv", "src/allowed.ts", "forbidden/moved.ts"], { cwd: repoDir, stdio: "ignore" })

    const taskPath = createTaskManifest()
    const resultPath = createResultManifest(["forbidden/moved.ts"])

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: repoDir,
      dryRun: true
    })

    const report = await finalizer.execute()
    expect(report.success).toBe(false)
    expect(report.error).toMatch(/(forbidden\/moved\.ts|Ownership violation)/i)
  })

  it("Scenario 4: rename forbidden -> allowed is rejected (tampering with forbidden source)", async () => {
    // Rename forbidden/secret.ts to src/hacked.ts
    execFileSync("git", ["mv", "forbidden/secret.ts", "src/hacked.ts"], { cwd: repoDir, stdio: "ignore" })

    const taskPath = createTaskManifest()
    const resultPath = createResultManifest(["src/hacked.ts"])

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: repoDir,
      dryRun: true
    })

    const report = await finalizer.execute()
    expect(report.success).toBe(false)
    expect(report.error).toMatch(/(forbidden\/secret\.ts|Ownership violation)/i)
  })

  it("Scenario 5: deleted forbidden file is rejected", async () => {
    // Delete forbidden/secret.ts
    execFileSync("git", ["rm", "forbidden/secret.ts"], { cwd: repoDir, stdio: "ignore" })

    const taskPath = createTaskManifest()
    const resultPath = createResultManifest(["forbidden/secret.ts"])

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: repoDir,
      dryRun: true
    })

    const report = await finalizer.execute()
    expect(report.success).toBe(false)
    expect(report.error).toMatch(/(forbidden\/secret\.ts|Ownership violation)/i)
  })

  it("Scenario 6: result contains file that Git says did not change", async () => {
    // Agent didn't modify anything on disk, but claims it changed src/allowed.ts
    const taskPath = createTaskManifest()
    const resultPath = createResultManifest(["src/allowed.ts"])

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: repoDir,
      dryRun: true
    })

    const report = await finalizer.execute()
    expect(report.success).toBe(false)
    expect(report.error).toMatch(/(Reported changed file that was not modified in Git|mismatch)/i)
  })

  it("Scenario 7: clean legitimate change passes", async () => {
    fs.appendFileSync(path.join(repoDir, "src", "allowed.ts"), "// valid modification\n")

    const taskPath = createTaskManifest()
    const resultPath = createResultManifest(["src/allowed.ts"])

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: repoDir,
      dryRun: true,
      customVerificationProfiles: {
        targeted: "node -e \"process.exit(0)\""
      }
    })

    const report = await finalizer.execute()
    expect(report.success).toBe(true)
    expect(report.error).toBeUndefined()
  })

  it("Scenario 8: GitChangeDetector rejects path traversal attempts", () => {
    const detector = new GitChangeDetector({
      workspaceRoot: repoDir,
      baseSha
    })
    expect(() => detector.normalizePath("../outside.ts")).toThrow(/traversal/i)
    expect(() => detector.normalizePath("foo/../../bar.ts")).toThrow(/traversal/i)
  })
})
