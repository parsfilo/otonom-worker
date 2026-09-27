import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { Finalizer, FinalizerConfig } from "../../harness/finalizer/finalizer.js"

describe("Finalizer PR Creation & Idempotency", () => {
  let tempDir: string
  let bareRemoteDir: string
  let taskPath: string
  let resultPath: string
  let baseSha: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "finalizer-pr-test-"))
    bareRemoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "bare-pr-remote-"))

    // Init bare remote
    execFileSync("git", ["init", "--bare"], { cwd: bareRemoteDir, stdio: "ignore" })

    // Init working repo
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: tempDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir, stdio: "ignore" })
    execFileSync("git", ["remote", "add", "origin", bareRemoteDir], { cwd: tempDir, stdio: "ignore" })

    fs.mkdirSync(path.join(tempDir, "docs", "swarm-smoke"), { recursive: true })
    const smokeDoc = path.join(tempDir, "docs", "swarm-smoke", "phase2-harness-validation.md")
    fs.writeFileSync(smokeDoc, "# Initial doc\n")
    execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "init"], { cwd: tempDir, stdio: "ignore" })
    execFileSync("git", ["push", "origin", "HEAD:refs/heads/main"], { cwd: tempDir, stdio: "ignore" })

    baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempDir, encoding: "utf-8" }).trim()

    // Task modification
    fs.appendFileSync(smokeDoc, "Smoke test content\n")

    taskPath = path.join(tempDir, "task.json")
    resultPath = path.join(tempDir, "result.json")

    const task = {
      id: "phase2-private-pr-smoke",
      title: "Validate private OpenCode agent pipeline",
      role: "builder-core",
      source_repository: "oaslananka/otonom",
      base_sha: baseSha,
      objectives: ["Create temporary swarm validation artifact"],
      allowed_write_paths: ["docs/swarm-smoke/phase2-harness-validation.md"],
      forbidden_write_paths: [],
      acceptance_criteria: ["Doc added"],
      verification_profile: "targeted",
      risk_classification: "LOW"
    }

    const result = {
      task_id: "phase2-private-pr-smoke",
      lane: "phase2-private-pr-smoke",
      base_sha: baseSha,
      status: "PASS",
      model_used: "free-model-zen-flash",
      changed_paths: ["docs/swarm-smoke/phase2-harness-validation.md"],
      verification_results: [
        {
          profile: "targeted",
          command: "node -e 'process.exit(0)'",
          exit_code: 0,
          passed: true,
          duration_ms: 50
        }
      ],
      test_summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
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
      fs.rmSync(bareRemoteDir, { recursive: true, force: true })
    } catch {}
  })

  it("creates a draft PR with sanitized metadata when none exists", async () => {
    let prCreated = false
    let prDraft = false
    let prTitle = ""

    const mockFetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      if (url.includes("/pulls?")) {
        // Query existing PRs -> returns empty array
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => []
        })
      }
      if (url.endsWith("/pulls") && opts?.method === "POST") {
        const body = JSON.parse(opts.body)
        prCreated = true
        prDraft = body.draft
        prTitle = body.title
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({
            number: 42,
            html_url: "https://github.com/oaslananka/otonom/pull/42",
            draft: true
          })
        })
      }
      return Promise.reject(new Error(`Unexpected url: ${url}`))
    })

    const config: FinalizerConfig = {
      taskPath,
      resultPath,
      workspaceRoot: tempDir,
      dryRun: false,
      workflowRunId: "test-run-123",
      targetToken: "ghp_target_test_token",
      createPr: true,
      customVerificationProfiles: {
        targeted: "node -e 'process.exit(0)'"
      },
      fetchFn: mockFetch as any
    }

    const finalizer = new Finalizer(config)
    const report = await finalizer.execute()

    expect(report.success).toBe(true)
    expect(report.pushed).toBe(true)
    expect(report.prUrl).toBe("https://github.com/oaslananka/otonom/pull/42")
    expect(prCreated).toBe(true)
    expect(prDraft).toBe(true)
    expect(prTitle).toContain("SWARM SMOKE")
  })

  it("idempotently reuses existing PR if one already exists for the head branch", async () => {
    let postCalled = false

    const mockFetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      if (url.includes("/pulls?")) {
        // Existing PR found
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [
            {
              number: 42,
              html_url: "https://github.com/oaslananka/otonom/pull/42",
              head: { ref: "swarm/test-run-123/phase2-private-pr-smoke" },
              draft: true
            }
          ]
        })
      }
      if (opts?.method === "POST") {
        postCalled = true
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({ number: 99 })
        })
      }
      return Promise.reject(new Error(`Unexpected url: ${url}`))
    })

    const config: FinalizerConfig = {
      taskPath,
      resultPath,
      workspaceRoot: tempDir,
      dryRun: false,
      workflowRunId: "test-run-123",
      targetToken: "ghp_target_test_token",
      createPr: true,
      customVerificationProfiles: {
        targeted: "node -e 'process.exit(0)'"
      },
      fetchFn: mockFetch as any
    }

    const finalizer = new Finalizer(config)
    const report = await finalizer.execute()

    expect(report.success).toBe(true)
    expect(report.prUrl).toBe("https://github.com/oaslananka/otonom/pull/42")
    // POST must NOT have been called because PR already existed
    expect(postCalled).toBe(false)
  })
})
