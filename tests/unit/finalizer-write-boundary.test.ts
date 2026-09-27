import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { Finalizer } from "../../harness/finalizer/finalizer.js"

describe("Hard Trust Boundary & Git Push in Finalizer", () => {
  let tempDir: string
  let bareRepoDir: string
  let workRepoDir: string
  let controlDir: string
  let baseSha: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "write-boundary-test-"))
    bareRepoDir = path.join(tempDir, "remote-bare.git")
    workRepoDir = path.join(tempDir, "work-repo")
    controlDir = path.join(tempDir, "control")

    fs.mkdirSync(bareRepoDir, { recursive: true })
    fs.mkdirSync(workRepoDir, { recursive: true })
    fs.mkdirSync(controlDir, { recursive: true })

    // 1. Initialize bare repository as mock remote
    execFileSync("git", ["init", "--bare"], { cwd: bareRepoDir, stdio: "ignore" })

    // 2. Initialize work repository
    execFileSync("git", ["init", "-b", "main"], { cwd: workRepoDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: workRepoDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workRepoDir, stdio: "ignore" })
    execFileSync("git", ["remote", "add", "origin", bareRepoDir], { cwd: workRepoDir, stdio: "ignore" })

    // Create initial commit on main
    fs.mkdirSync(path.join(workRepoDir, "src"), { recursive: true })
    fs.writeFileSync(path.join(workRepoDir, "src", "index.ts"), "export const initial = true;\n")
    execFileSync("git", ["add", "."], { cwd: workRepoDir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "initial commit on main"], { cwd: workRepoDir, stdio: "ignore" })
    execFileSync("git", ["push", "origin", "main"], { cwd: workRepoDir, stdio: "ignore" })

    baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workRepoDir, encoding: "utf-8" }).trim()
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function setupTaskAndResult(changedFile = "src/index.ts") {
    const taskPath = path.join(controlDir, "task.json")
    const resultPath = path.join(controlDir, "result.json")

    const task = {
      id: "lane-write-test",
      title: "Write Boundary Lane",
      role: "builder-core",
      source_repository: "oaslananka/otonom",
      base_sha: baseSha,
      objectives: ["Update index"],
      allowed_write_paths: ["src/**"],
      forbidden_write_paths: [],
      acceptance_criteria: ["Passes verification check"],
      verification_profile: "lane",
      risk_classification: "LOW"
    }

    const result = {
      task_id: "lane-write-test",
      lane: "lane-write-test",
      base_sha: baseSha,
      status: "PASS",
      model_used: "zen:gemini-2.5-flash",
      changed_paths: [changedFile],
      policy_violations: [],
      test_summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
      verification_results: [
        {
          profile: "lane",
          command: "node -e 'process.exit(0)'",
          exit_code: 0,
          passed: true,
          duration_ms: 10
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

    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2))
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2))
    return { taskPath, resultPath }
  }

  it("Test 1: push succeeds to local bare repo fixture in non-dry-run mode", async () => {
    // Modify file
    fs.appendFileSync(path.join(workRepoDir, "src", "index.ts"), "// automated modification\n")

    const { taskPath, resultPath } = setupTaskAndResult("src/index.ts")

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: workRepoDir,
      dryRun: false,
      workflowRunId: "run-42",
      targetToken: "fake-test-token",
      targetRemote: "origin",
      customVerificationProfiles: {
        lane: "node -e 'process.exit(0)'"
      }
    })

    const report = await finalizer.execute()
    expect(report.success).toBe(true)
    expect(report.pushed).toBe(true)
    expect(report.branchName).toBe("swarm/run-42/lane-write-test")
    expect(report.commitSha).toBeDefined()

    // Verify bare remote received the branch
    const remoteBranches = execFileSync("git", ["branch", "-a"], { cwd: bareRepoDir, encoding: "utf-8" })
    expect(remoteBranches).toContain("swarm/run-42/lane-write-test")
  })

  it("Test 2: git hooks are bypassed and project scripts never execute with write credentials", async () => {
    fs.appendFileSync(path.join(workRepoDir, "src", "index.ts"), "// edit\n")

    // Install a malicious pre-push hook in work-repo
    const hooksDir = path.join(workRepoDir, ".git", "hooks")
    fs.mkdirSync(hooksDir, { recursive: true })
    const prePushHook = path.join(hooksDir, "pre-push")
    fs.writeFileSync(prePushHook, "#!/bin/sh\necho 'MALICIOUS HOOK EXECUTED' >&2\nexit 1\n")
    if (process.platform !== "win32") {
      fs.chmodSync(prePushHook, "755")
    }

    const { taskPath, resultPath } = setupTaskAndResult("src/index.ts")

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: workRepoDir,
      dryRun: false,
      workflowRunId: "run-hook-bypass",
      targetToken: "fake-token",
      targetRemote: "origin",
      customVerificationProfiles: {
        lane: "node -e 'process.exit(0)'"
      }
    })

    // If hooks were NOT bypassed with core.hooksPath=/dev/null, pre-push would fail the push with exit 1
    const report = await finalizer.execute()
    expect(report.success).toBe(true)
    expect(report.pushed).toBe(true)
  })

  it("Test 3: target write token is never written into .git/config url", async () => {
    fs.appendFileSync(path.join(workRepoDir, "src", "index.ts"), "// edit\n")

    const secretToken = "SECRET_TOKEN_DO_NOT_PERSIST_IN_CONFIG_12345"
    const { taskPath, resultPath } = setupTaskAndResult("src/index.ts")

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: workRepoDir,
      dryRun: false,
      workflowRunId: "run-no-leak",
      targetToken: secretToken,
      targetRemote: "origin",
      customVerificationProfiles: {
        lane: "node -e 'process.exit(0)'"
      }
    })

    await finalizer.execute()

    // Inspect git config content
    const gitConfigFile = path.join(workRepoDir, ".git", "config")
    const configContent = fs.readFileSync(gitConfigFile, "utf-8")
    expect(configContent).not.toContain(secretToken)
  })

  it("Test 4: never pushes to main or master", async () => {
    fs.appendFileSync(path.join(workRepoDir, "src", "index.ts"), "// edit\n")

    const { taskPath, resultPath } = setupTaskAndResult("src/index.ts")

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: workRepoDir,
      dryRun: false,
      workflowRunId: "run-main",
      targetToken: "fake-token",
      customVerificationProfiles: {
        lane: "node -e 'process.exit(0)'"
      }
    })

    // Attempting to push to main is blocked
    expect(() => {
      finalizer.validatePushBranch("main")
    }).toThrow(/protected main/i)
    expect(() => {
      finalizer.validatePushBranch("master")
    }).toThrow(/protected main/i)
  })

  it("Test 5: base SHA mismatch is rejected", async () => {
    fs.appendFileSync(path.join(workRepoDir, "src", "index.ts"), "// edit\n")

    const { taskPath, resultPath } = setupTaskAndResult("src/index.ts")

    // Set invalid base sha in task
    const badTask = JSON.parse(fs.readFileSync(taskPath, "utf-8"))
    badTask.base_sha = "0000000000000000000000000000000000000000"
    fs.writeFileSync(taskPath, JSON.stringify(badTask, null, 2))

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: workRepoDir,
      dryRun: false,
      workflowRunId: "run-base-mismatch",
      targetToken: "fake-token",
      customVerificationProfiles: {
        lane: "node -e 'process.exit(0)'"
      }
    })

    const report = await finalizer.execute()
    expect(report.success).toBe(false)
    expect(report.error).toMatch(/(base sha|mismatch|ancestor)/i)
  })

  it("Test 6: dry-run mode performs no network or branch push", async () => {
    fs.appendFileSync(path.join(workRepoDir, "src", "index.ts"), "// dry run edit\n")

    const { taskPath, resultPath } = setupTaskAndResult("src/index.ts")

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: workRepoDir,
      dryRun: true,
      workflowRunId: "run-dry",
      customVerificationProfiles: {
        lane: "node -e 'process.exit(0)'"
      }
    })

    const report = await finalizer.execute()
    expect(report.success).toBe(true)
    expect(report.dryRun).toBe(true)
    expect(report.pushed).toBe(false)

    // Remote bare repo must NOT have received swarm/run-dry/lane-write-test
    const remoteBranches = execFileSync("git", ["branch", "-a"], { cwd: bareRepoDir, encoding: "utf-8" })
    expect(remoteBranches).not.toContain("swarm/run-dry/lane-write-test")
  })
})
