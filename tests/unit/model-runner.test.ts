import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
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
})
