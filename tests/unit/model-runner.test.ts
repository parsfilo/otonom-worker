import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { ModelSelector } from "../../harness/runtime/model-selector.js"
import { ModelExecutor } from "../../harness/runtime/model-executor.js"

describe("Model Selector & Execution Driver with Fallback", () => {
  let tempDir: string
  let privateDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-executor-test-"))
    privateDir = path.join(tempDir, "private")
    fs.mkdirSync(privateDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it("Test 1: first model succeeds -> returns PASS and records actual model", async () => {
    const selector = new ModelSelector()
    const fakeRunnerFactory = (model: string) => ({
      run: async () => ({
        exitCode: 0,
        status: "PASS" as const,
        durationMs: 100,
        timedOut: false,
        stalled: false,
        stdoutPath: path.join(privateDir, "out.log"),
        stderrPath: path.join(privateDir, "err.log"),
        sanitizedSummary: `Success with ${model}`
      })
    })

    const executor = new ModelExecutor({
      selector,
      runnerFactory: fakeRunnerFactory as any,
      maxAttempts: 3
    })

    const result = await executor.executeLane("lane-1", "builder-core")
    expect(result.success).toBe(true)
    expect(result.status).toBe("PASS")
    expect(result.actualModel).toMatch(/^opencode\/.*-free/)
    expect(result.attempts.length).toBe(1)
  })

  it("Test 2: first rate-limited -> second succeeds", async () => {
    const selector = new ModelSelector()
    let attemptCount = 0

    const fakeRunnerFactory = (model: string) => ({
      run: async () => {
        attemptCount++
        if (attemptCount === 1) {
          return {
            exitCode: 42,
            status: "RATE_LIMITED" as const,
            durationMs: 50,
            timedOut: false,
            stalled: false,
            stdoutPath: path.join(privateDir, "out.log"),
            stderrPath: path.join(privateDir, "err.log"),
            sanitizedSummary: "Rate limited"
          }
        }
        return {
          exitCode: 0,
          status: "PASS" as const,
          durationMs: 100,
          timedOut: false,
          stalled: false,
          stdoutPath: path.join(privateDir, "out.log"),
          stderrPath: path.join(privateDir, "err.log"),
          sanitizedSummary: `Success with ${model}`
        }
      }
    })

    const executor = new ModelExecutor({
      selector,
      runnerFactory: fakeRunnerFactory as any,
      maxAttempts: 3
    })

    const result = await executor.executeLane("lane-1", "builder-core")
    expect(result.success).toBe(true)
    expect(result.status).toBe("PASS")
    expect(result.actualModel).toMatch(/^opencode\/.*-free/)
    expect(result.actualModel).not.toBe(result.attempts[0].model)
    expect(result.attempts.length).toBe(2)
    expect(result.attempts[0].status).toBe("RATE_LIMITED")
    expect(result.attempts[1].status).toBe("PASS")
  })

  it("Test 3: first stalls -> second succeeds", async () => {
    const selector = new ModelSelector()
    let attemptCount = 0

    const fakeRunnerFactory = (model: string) => ({
      run: async () => {
        attemptCount++
        if (attemptCount === 1) {
          return {
            exitCode: null,
            status: "STALLED" as const,
            durationMs: 500,
            timedOut: true,
            stalled: true,
            stdoutPath: path.join(privateDir, "out.log"),
            stderrPath: path.join(privateDir, "err.log"),
            sanitizedSummary: "Stalled"
          }
        }
        return {
          exitCode: 0,
          status: "PASS" as const,
          durationMs: 120,
          timedOut: false,
          stalled: false,
          stdoutPath: path.join(privateDir, "out.log"),
          stderrPath: path.join(privateDir, "err.log"),
          sanitizedSummary: `Success with ${model}`
        }
      }
    })

    const executor = new ModelExecutor({
      selector,
      runnerFactory: fakeRunnerFactory as any,
      maxAttempts: 3
    })

    const result = await executor.executeLane("lane-1", "builder-core")
    expect(result.success).toBe(true)
    expect(result.status).toBe("PASS")
    expect(result.attempts[0].status).toBe("STALLED")
    expect(result.attempts[1].status).toBe("PASS")
  })

  it("Test 4: unavailable model in catalog is skipped", async () => {
    const selector = new ModelSelector({
      availableCatalog: ["opencode/longcat-2.5-preview-free"]
    })

    const fakeRunnerFactory = (model: string) => ({
      run: async () => ({
        exitCode: 0,
        status: "PASS" as const,
        durationMs: 80,
        timedOut: false,
        stalled: false,
        stdoutPath: path.join(privateDir, "out.log"),
        stderrPath: path.join(privateDir, "err.log"),
        sanitizedSummary: `Success with ${model}`
      })
    })

    const executor = new ModelExecutor({
      selector,
      runnerFactory: fakeRunnerFactory as any,
      maxAttempts: 3
    })

    const result = await executor.executeLane("lane-1", "builder-core")
    expect(result.success).toBe(true)
    expect(result.actualModel).toBe("opencode/longcat-2.5-preview-free")
  })

  it("Test 5: all models exhausted -> explicit failure", async () => {
    const selector = new ModelSelector()
    const fakeRunnerFactory = (model: string) => ({
      run: async () => ({
        exitCode: 42,
        status: "RATE_LIMITED" as const,
        durationMs: 50,
        timedOut: false,
        stalled: false,
        stdoutPath: path.join(privateDir, "out.log"),
        stderrPath: path.join(privateDir, "err.log"),
        sanitizedSummary: "Rate limited"
      })
    })

    const executor = new ModelExecutor({
      selector,
      runnerFactory: fakeRunnerFactory as any,
      maxAttempts: 2
    })

    const result = await executor.executeLane("lane-1", "builder-core")
    expect(result.success).toBe(false)
    expect(result.status).toBe("RATE_LIMITED")
    expect(result.attempts.length).toBe(2)
  })

  it("Test 6: deterministic verification failure does NOT retry infinitely", async () => {
    const selector = new ModelSelector()
    let calls = 0

    const fakeRunnerFactory = (model: string) => ({
      run: async () => {
        calls++
        return {
          exitCode: 1,
          status: "FAIL" as const,
          durationMs: 90,
          timedOut: false,
          stalled: false,
          stdoutPath: path.join(privateDir, "out.log"),
          stderrPath: path.join(privateDir, "err.log"),
          sanitizedSummary: "Tests failed"
        }
      }
    })

    const executor = new ModelExecutor({
      selector,
      runnerFactory: fakeRunnerFactory as any,
      maxAttempts: 4
    })

    const result = await executor.executeLane("lane-1", "builder-core")
    expect(result.success).toBe(false)
    expect(result.status).toBe("FAIL")
    // Deterministic failure must NOT retry across different models
    expect(calls).toBe(1)
  })

  it("Test 7: capability workspace pollution blocks model execution", async () => {
    const repoDir = path.join(tempDir, "target")
    fs.mkdirSync(repoDir, { recursive: true })
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" })
    fs.writeFileSync(path.join(repoDir, "README.md"), "fixture\n")
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "ignore" })
    fs.mkdirSync(path.join(repoDir, ".serena"), { recursive: true })
    fs.writeFileSync(path.join(repoDir, ".serena", ".gitignore"), "*\n")

    let calls = 0
    const executor = new ModelExecutor({
      selector: new ModelSelector(),
      workspaceDir: repoDir,
      runnerFactory: () => ({
        run: async () => {
          calls++
          throw new Error("runner must not start")
        }
      }),
      maxAttempts: 1
    })

    const result = await executor.executeLane("lane-polluted", "builder-core")
    expect(result).toMatchObject({
      success: false,
      status: "FAIL",
      error: "CAPABILITY_WORKSPACE_POLLUTION"
    })
    expect(calls).toBe(0)
  })

  it("Test 8: clean bootstrapped workspace reaches model execution", async () => {
    const repoDir = path.join(tempDir, "clean-target")
    fs.mkdirSync(repoDir, { recursive: true })
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" })
    fs.writeFileSync(path.join(repoDir, "README.md"), "fixture\n")
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "ignore" })

    const executor = new ModelExecutor({
      selector: new ModelSelector(),
      workspaceDir: repoDir,
      runnerFactory: () => ({
        run: async () => ({
          exitCode: 0,
          status: "PASS",
          durationMs: 1,
          timedOut: false,
          stalled: false,
          stdoutPath: "",
          stderrPath: "",
          sanitizedSummary: "PASS"
        })
      }),
      maxAttempts: 1
    })

    await expect(executor.executeLane("lane-clean", "builder-core")).resolves.toMatchObject({
      success: true,
      status: "PASS"
    })
  })

  it("Test 9: requires_changes rejects process exit 0 with no work product and falls back", async () => {
    const repoDir = path.join(tempDir, "requires-changes")
    fs.mkdirSync(repoDir, { recursive: true })
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" })
    fs.writeFileSync(path.join(repoDir, "README.md"), "base\n")
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "base"], { cwd: repoDir, stdio: "ignore" })
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf-8" }).trim()
    let calls = 0

    const executor = new ModelExecutor({
      selector: new ModelSelector(),
      workspaceDir: repoDir,
      baseSha,
      requiresChanges: true,
      runnerFactory: () => ({
        run: async () => {
          calls++
          if (calls === 2) fs.writeFileSync(path.join(repoDir, "work.txt"), "done\n")
          return {
            exitCode: 0,
            status: "PASS" as const,
            durationMs: 1,
            timedOut: false,
            stalled: false,
            stdoutPath: "",
            stderrPath: "",
            sanitizedSummary: "process exited"
          }
        }
      }),
      maxAttempts: 2
    })

    const result = await executor.executeLane("lane-requires-work", "builder-core")
    expect(result.success).toBe(true)
    expect(calls).toBe(2)
    expect(result.attempts[0].errorCategory).toBe("NO_WORK_PRODUCT")
    expect(result.attempts[1].status).toBe("PASS")
  })

  it("Test 10: requires_changes fails truthfully when every model exits without changing the repository", async () => {
    const repoDir = path.join(tempDir, "no-work")
    fs.mkdirSync(repoDir, { recursive: true })
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" })
    fs.writeFileSync(path.join(repoDir, "README.md"), "base\n")
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "base"], { cwd: repoDir, stdio: "ignore" })
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf-8" }).trim()

    const executor = new ModelExecutor({
      selector: new ModelSelector(),
      workspaceDir: repoDir,
      baseSha,
      requiresChanges: true,
      runnerFactory: () => ({
        run: async () => ({
          exitCode: 0,
          status: "PASS" as const,
          durationMs: 1,
          timedOut: false,
          stalled: false,
          stdoutPath: "",
          stderrPath: "",
          sanitizedSummary: "process exited"
        })
      }),
      maxAttempts: 2
    })

    const result = await executor.executeLane("lane-no-work", "builder-core")
    expect(result.success).toBe(false)
    expect(result.status).toBe("FAIL")
    expect(result.error).toBe("NO_WORK_PRODUCT")
    expect(result.attempts).toHaveLength(2)
  })


  it("Test 11: process PASS without complete_lane result falls back to another free model", async () => {
    const repoDir = path.join(tempDir, "completion-result")
    const controlDir = path.join(tempDir, "completion-control")
    const resultPath = path.join(controlDir, "result.json")
    fs.mkdirSync(repoDir, { recursive: true })
    fs.mkdirSync(controlDir, { recursive: true })
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" })
    fs.writeFileSync(path.join(repoDir, "README.md"), "base\n")
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "base"], { cwd: repoDir, stdio: "ignore" })
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf-8" }).trim()
    let calls = 0

    const executor = new ModelExecutor({
      selector: new ModelSelector(),
      workspaceDir: repoDir,
      baseSha,
      requiresChanges: true,
      completionResultPath: resultPath,
      requireCompletionResult: true,
      runnerFactory: () => ({
        run: async () => {
          calls++
          fs.writeFileSync(path.join(repoDir, "work.txt"), `attempt-${calls}\n`)
          if (calls === 2) {
            fs.writeFileSync(resultPath, JSON.stringify({
              task_id: "lane-completion",
              lane: "lane-completion",
              status: "PASS"
            }))
          }
          return {
            exitCode: 0,
            status: "PASS" as const,
            durationMs: 1,
            timedOut: false,
            stalled: false,
            stdoutPath: "",
            stderrPath: "",
            sanitizedSummary: "process exited"
          }
        }
      }),
      maxAttempts: 2
    })

    const result = await executor.executeLane("lane-completion", "builder-core")
    expect(result.success).toBe(true)
    expect(calls).toBe(2)
    expect(result.attempts[0].errorCategory).toBe("RESULT_MISSING")
    expect(result.attempts[1].status).toBe("PASS")
  })

})
