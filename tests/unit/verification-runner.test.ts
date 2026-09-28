import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { VerificationRunner, VerificationProfile } from "../../harness/verification/runner.js"
import { evaluateLaneCompletion } from "../../harness/verification/completion-gate.js"

describe("Verification Runner & Completion Gate", () => {
  let tempDir: string
  let taskPath: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "verif-test-"))
    taskPath = path.join(tempDir, "task.json")
    fs.writeFileSync(taskPath, JSON.stringify({
      id: "verification-lane",
      title: "Verification lane fixture",
      role: "builder-core",
      source_repository: "oaslananka/otonom",
      base_sha: "0123456789abcdef0123456789abcdef01234567",
      objectives: ["Verify fixture behavior"],
      allowed_write_paths: ["src/**"],
      acceptance_criteria: ["Verification passes"],
      verification_profile: "lane",
      risk_classification: "LOW"
    }))
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

  it("target-ci performs trusted diff hygiene without invoking the target package manager", async () => {
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: tempDir })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir })
    fs.writeFileSync(path.join(tempDir, "README.md"), "base\n")
    execFileSync("git", ["add", "."], { cwd: tempDir })
    execFileSync("git", ["commit", "-m", "base"], { cwd: tempDir, stdio: "ignore" })
    fs.writeFileSync(path.join(tempDir, "README.md"), "changed\n")

    const runner = new VerificationRunner({ cwd: tempDir })
    const result = await runner.runProfile("target-ci")

    expect(result.command).toBe("git diff --check")
    expect(result.passed).toBe(true)
    expect(result.exit_code).toBe(0)
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

  it("does not pass trusted credentials to project verification commands", async () => {
    const capturePath = path.join(tempDir, "verification-env.json")
    const names = [
      "DOPPLER_TOKEN",
      "OTONOM_SOURCE_CLONE_TOKEN",
      "OTONOM_TARGET_WRITE_TOKEN",
      "VERIFICATION_ENV_CAPTURE"
    ] as const
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
    const expectedPath = process.env.PATH

    process.env.DOPPLER_TOKEN = "fake-doppler-token"
    process.env.OTONOM_SOURCE_CLONE_TOKEN = "fake-source-token"
    process.env.OTONOM_TARGET_WRITE_TOKEN = "fake-write-token"
    process.env.VERIFICATION_ENV_CAPTURE = capturePath

    try {
      const runner = new VerificationRunner({
        cwd: tempDir,
        customProfiles: {
          capture:
            `node -e "require('node:fs').writeFileSync(process.env.VERIFICATION_ENV_CAPTURE, JSON.stringify({ doppler: process.env.DOPPLER_TOKEN, source: process.env.OTONOM_SOURCE_CLONE_TOKEN, write: process.env.OTONOM_TARGET_WRITE_TOKEN, path: process.env.PATH }))"`
        }
      })

      const result = await runner.runProfile("capture")
      expect(result.passed).toBe(true)
      const captured = JSON.parse(fs.readFileSync(capturePath, "utf-8"))
      expect(captured).not.toHaveProperty("doppler")
      expect(captured).not.toHaveProperty("source")
      expect(captured).not.toHaveProperty("write")
      expect(captured.path).toContain(expectedPath || "")
    } finally {
      for (const name of names) {
        const value = previous[name]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it("rejects arbitrary or unknown verification profile", async () => {
    const runner = new VerificationRunner()
    await expect(runner.runProfile("unknown-profile" as any)).rejects.toThrow(/Unknown verification profile/)
  })

  it("complete_lane refuses completion when verification is missing", () => {
    const check = evaluateLaneCompletion({
      taskPath,
      latestVerification: undefined,
      ownershipViolations: [],
      changedPaths: ["src/file.ts"]
    })

    expect(check.canComplete).toBe(false)
    expect(check.reason).toMatch(/No verification has been run/)
  })

  it("complete_lane refuses completion when latest verification failed", () => {
    const check = evaluateLaneCompletion({
      taskPath,
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
      taskPath,
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
      taskPath,
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

  it("complete_lane rejects requires_changes tasks with zero changed paths", () => {
    const task = JSON.parse(fs.readFileSync(taskPath, "utf-8"))
    task.requires_changes = true
    fs.writeFileSync(taskPath, JSON.stringify(task))

    const check = evaluateLaneCompletion({
      taskPath,
      latestVerification: {
        profile: "lane",
        command: "npm test",
        exit_code: 0,
        passed: true,
        duration_ms: 10
      },
      ownershipViolations: [],
      changedPaths: []
    })

    expect(check.canComplete).toBe(false)
    expect(check.reason).toContain("NO_WORK_PRODUCT")
  })

})
