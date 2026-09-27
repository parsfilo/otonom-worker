import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { runConfidentialityCheck } from "../../harness/policies/confidentiality-check.js"

describe("Live Confidentiality Check", () => {
  let tempDir: string
  let controlDir: string
  let privateDir: string
  let targetDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "confidentiality-test-"))
    controlDir = path.join(tempDir, "control")
    privateDir = path.join(tempDir, "private")
    targetDir = path.join(tempDir, "target")

    fs.mkdirSync(controlDir, { recursive: true })
    fs.mkdirSync(privateDir, { recursive: true })
    fs.mkdirSync(path.join(targetDir, ".git"), { recursive: true })

    fs.writeFileSync(path.join(privateDir, "sentinel.log"), "PRIVATE_LOG_SENTINEL_PHASE2\n")
    fs.writeFileSync(path.join(controlDir, "task.json"), JSON.stringify({ id: "test" }))
    fs.writeFileSync(path.join(controlDir, "result.json"), JSON.stringify({ status: "PASS" }))
    fs.writeFileSync(path.join(controlDir, "finalizer-report.json"), JSON.stringify({ success: true }))
    fs.writeFileSync(path.join(targetDir, ".git", "config"), "[core]\n\tbare = false\n")
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it("passes when sentinel exists in private log and artifacts are clean", () => {
    const res = runConfidentialityCheck(controlDir, privateDir, targetDir)
    expect(res.valid).toBe(true)
    expect(res.sentinelFoundInPrivateLog).toBe(true)
    expect(res.secretPatternsFoundInArtifacts).toBe(0)
    expect(res.gitConfigClean).toBe(true)
  })

  it("fails if private sentinel is missing", () => {
    fs.unlinkSync(path.join(privateDir, "sentinel.log"))
    const res = runConfidentialityCheck(controlDir, privateDir, targetDir)
    expect(res.valid).toBe(false)
    expect(res.sentinelFoundInPrivateLog).toBe(false)
  })

  it("fails if secret pattern leaks into control artifacts", () => {
    fs.writeFileSync(
      path.join(controlDir, "result.json"),
      JSON.stringify({ status: "PASS", token: "ghp_1234567890123456789012345" })
    )
    const res = runConfidentialityCheck(controlDir, privateDir, targetDir)
    expect(res.valid).toBe(false)
    expect(res.secretPatternsFoundInArtifacts).toBeGreaterThan(0)
  })

  it("fails if forbidden pattern is detected in target .git/config", () => {
    fs.writeFileSync(
      path.join(targetDir, ".git", "config"),
      "[http]\n\textraheader = AUTHORIZATION: basic dXNlcjpwYXNz\n"
    )
    const res = runConfidentialityCheck(controlDir, privateDir, targetDir)
    expect(res.valid).toBe(false)
    expect(res.gitConfigClean).toBe(false)
  })
})
