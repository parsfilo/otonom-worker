import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { SourceBootstrapper } from "../../harness/runtime/source-bootstrap.js"

describe("Trusted Source Bootstrap", () => {
  let tempDir: string
  let bareOriginDir: string
  let targetCheckoutDir: string
  let validCommitSha: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "source-bootstrap-test-"))
    bareOriginDir = path.join(tempDir, "remote-bare.git")
    targetCheckoutDir = path.join(tempDir, "target-workspace")

    fs.mkdirSync(bareOriginDir, { recursive: true })

    // Create a bare remote repo with a real commit
    const initWorkDir = path.join(tempDir, "temp-init-work")
    fs.mkdirSync(initWorkDir, { recursive: true })

    execFileSync("git", ["init", "--bare"], { cwd: bareOriginDir, stdio: "ignore" })
    execFileSync("git", ["init", "-b", "main"], { cwd: initWorkDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Source Author"], { cwd: initWorkDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "author@otonom.internal"], { cwd: initWorkDir, stdio: "ignore" })
    execFileSync("git", ["remote", "add", "origin", bareOriginDir], { cwd: initWorkDir, stdio: "ignore" })

    fs.mkdirSync(path.join(initWorkDir, "src"), { recursive: true })
    fs.writeFileSync(path.join(initWorkDir, "src", "core.ts"), "export const CORE = 'private_source';\n")
    execFileSync("git", ["add", "."], { cwd: initWorkDir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "initial commit of private target repo"], { cwd: initWorkDir, stdio: "ignore" })
    execFileSync("git", ["push", "origin", "main"], { cwd: initWorkDir, stdio: "ignore" })

    validCommitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: initWorkDir, encoding: "utf-8" }).trim()
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it("Test 1: clones repository to exact target SHA using bare repo fixture", async () => {
    const fakeToken = "ghp_ReadOnlySourceCloneToken12345"
    const bootstrapper = new SourceBootstrapper({
      repoUrl: bareOriginDir,
      cloneToken: fakeToken,
      targetSha: validCommitSha,
      destinationDir: targetCheckoutDir
    })

    const result = await bootstrapper.bootstrap()
    expect(result.success).toBe(true)
    expect(result.checkedOutSha).toBe(validCommitSha)

    // Verify source file exists in checked out workspace
    const coreFile = path.join(targetCheckoutDir, "src", "core.ts")
    expect(fs.existsSync(coreFile)).toBe(true)
    expect(fs.readFileSync(coreFile, "utf-8")).toContain("private_source")
  })

  it("Test 2: verifies checked out SHA matches targetSha and rejects mismatch", async () => {
    const badSha = "0123456789abcdef0123456789abcdef01234567"
    const bootstrapper = new SourceBootstrapper({
      repoUrl: bareOriginDir,
      targetSha: badSha,
      destinationDir: targetCheckoutDir
    })

    const result = await bootstrapper.bootstrap()
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/(SHA mismatch|not found|failed to checkout)/i)
  })

  it("Test 3: clone token is NEVER persisted in .git/config", async () => {
    const secretToken = "SECRET_TOKEN_NEVER_WRITE_TO_DISK_998877"
    const bootstrapper = new SourceBootstrapper({
      repoUrl: bareOriginDir,
      cloneToken: secretToken,
      targetSha: validCommitSha,
      destinationDir: targetCheckoutDir
    })

    await bootstrapper.bootstrap()

    const gitConfigFile = path.join(targetCheckoutDir, ".git", "config")
    expect(fs.existsSync(gitConfigFile)).toBe(true)
    const configContent = fs.readFileSync(gitConfigFile, "utf-8")
    expect(configContent).not.toContain(secretToken)
  })

  it("Test 4: sets core.hooksPath=/dev/null and disables credential helper defensively", async () => {
    const bootstrapper = new SourceBootstrapper({
      repoUrl: bareOriginDir,
      targetSha: validCommitSha,
      destinationDir: targetCheckoutDir
    })

    await bootstrapper.bootstrap()

    const hooksPath = execFileSync("git", ["config", "--local", "core.hooksPath"], {
      cwd: targetCheckoutDir,
      encoding: "utf-8"
    }).trim()
    expect(hooksPath).toBe("/dev/null")

    const helper = execFileSync("git", ["config", "--local", "credential.helper"], {
      cwd: targetCheckoutDir,
      encoding: "utf-8"
    }).trim()
    expect(helper).toBe("")
  })
})
