import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { VerificationRunner, VerificationProfile } from "../../harness/verification/runner.js"
import { evaluateLaneCompletion } from "../../harness/verification/completion-gate.js"

describe("Verification Runner & Completion Gate", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "verif-test-"))
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it("executes named verification profile and records structured result", async () => {
    const runner = new VerificationRunner({
      customProfiles: {
        targeted: "node -e 'process.exit(0)'",
        lane: "node -e 'process.exit(0)'"
      }
    })

    const result = await runner.runProfile("targeted")
    expect(result.profile).toBe("targeted")
    expect(result.exit_code).toBe(0)
    expect(result.passed).toBe(true)
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it("handles failing command with passed = false", async () => {
    const runner = new VerificationRunner({
      customProfiles: {
        failing: "node -e 'process.exit(2)'"
      }
    })

    const result = await runner.runProfile("failing")
    expect(result.exit_code).toBe(2)
    expect(result.passed).toBe(false)
  })

  it("rejects arbitrary or unknown verification profile", async () => {
    const runner = new VerificationRunner()
    await expect(runner.runProfile("unknown-profile" as any)).rejects.toThrow(/Unknown verification profile/)
  })

  it("complete_lane refuses completion when verification is missing", () => {
    const check = evaluateLaneCompletion({
      taskPath: "task.json",
      latestVerification: undefined,
      ownershipViolations: [],
      changedPaths: ["src/file.ts"]
    })

    expect(check.canComplete).toBe(false)
    expect(check.reason).toMatch(/No verification has been run/)
  })

  it("complete_lane refuses completion when latest verification failed", () => {
    const check = evaluateLaneCompletion({
      taskPath: "task.json",
      latestVerification: {
        profile: "lane",
        command: "npm test",
        exit_code: 1,
        passed: false,
        duration_ms: 500
      },
      ownershipViolations: [],
      changedPaths: ["src/file.ts"]
    })

    expect(check.canComplete).toBe(false)
    expect(check.reason).toMatch(/Latest verification failed/)
  })

  it("complete_lane refuses completion when ownership violations exist", () => {
    const check = evaluateLaneCompletion({
      taskPath: "task.json",
      latestVerification: {
        profile: "lane",
        command: "npm test",
        exit_code: 0,
        passed: true,
        duration_ms: 500
      },
      ownershipViolations: [
        {
          policy: "OUT_OF_SCOPE_WRITE",
          detail: "illegal write",
          target: "src/secrets.ts",
          timestamp: new Date().toISOString()
        }
      ],
      changedPaths: ["src/file.ts"]
    })

    expect(check.canComplete).toBe(false)
    expect(check.reason).toMatch(/Unresolved ownership violations/)
  })

  it("complete_lane succeeds when verification passes and ownership clean", () => {
    const check = evaluateLaneCompletion({
      taskPath: "task.json",
      latestVerification: {
        profile: "lane",
        command: "npm test",
        exit_code: 0,
        passed: true,
        duration_ms: 500
      },
      ownershipViolations: [],
      changedPaths: ["src/webhooks/receiver.ts"]
    })

    expect(check.canComplete).toBe(true)
  })
})
