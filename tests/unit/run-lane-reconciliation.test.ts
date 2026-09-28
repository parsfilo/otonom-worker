import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { reconcileTrustedLaneResult } from "../../harness/runtime/run-lane.js"

function initRepo(root: string) {
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" })
  execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: root })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root })
  fs.writeFileSync(path.join(root, "README.md"), "base\n")
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" })
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim()
}

describe("trusted lane result reconciliation", () => {
  let root: string
  let repo: string
  let control: string
  let baseSha: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "run-lane-reconcile-"))
    repo = path.join(root, "repo")
    control = path.join(root, "control")
    fs.mkdirSync(repo, { recursive: true })
    fs.mkdirSync(control, { recursive: true })
    baseSha = initRepo(repo)
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const execPass = {
    success: true,
    status: "PASS" as const,
    actualModel: "opencode/mimo-v2.6-flash-free",
    attempts: []
  }

  function task(overrides: Record<string, unknown> = {}) {
    return {
      id: "phase2-private-pr-smoke",
      role: "builder-core",
      base_sha: baseSha,
      allowed_write_paths: ["docs/swarm-smoke/phase2-harness-validation.md"],
      verification_profile: "smoke-doc",
      requires_changes: true,
      ...overrides
    }
  }

  it("creates authoritative PASS from git state and trusted verification even when agent result is missing", async () => {
    const out = path.join(repo, "docs/swarm-smoke/phase2-harness-validation.md")
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, "# smoke\n")
    const resultPath = path.join(control, "result.json")

    const result = await reconcileTrustedLaneResult({ task: task(), execResult: execPass, resultPath, targetWorkspaceDir: repo })
    expect(result.status).toBe("PASS")
    expect(result.changed_paths).toEqual(["docs/swarm-smoke/phase2-harness-validation.md"])
    expect(result.verification_results[0].passed).toBe(true)
    expect(JSON.parse(fs.readFileSync(resultPath, "utf-8")).status).toBe("PASS")
  })

  it("fails closed for authoritative out-of-scope changes", async () => {
    fs.writeFileSync(path.join(repo, "pnpm-lock.yaml"), "unexpected\n")
    const result = await reconcileTrustedLaneResult({
      task: task({ allowed_write_paths: ["docs/**"] }),
      execResult: execPass,
      resultPath: path.join(control, "result.json"),
      targetWorkspaceDir: repo
    })
    expect(result.status).toBe("FAIL")
    expect(result.remaining_blockers).toContain("OUT_OF_SCOPE_WORK_PRODUCT")
    expect(result.policy_violations[0].target).toBe("pnpm-lock.yaml")
  })

  it("fails closed when required work is absent", async () => {
    const result = await reconcileTrustedLaneResult({
      task: task(),
      execResult: execPass,
      resultPath: path.join(control, "result.json"),
      targetWorkspaceDir: repo
    })
    expect(result.status).toBe("FAIL")
    expect(result.remaining_blockers).toContain("NO_WORK_PRODUCT")
  })
})
