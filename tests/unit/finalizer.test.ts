import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { Finalizer, FinalizerConfig } from "../../harness/finalizer/finalizer.js"

describe("Finalizer", () => {
  let tempDir: string
  let taskPath: string
  let resultPath: string

  const mockTask = {
    id: "webhook-durability",
    title: "Webhook durability",
    role: "builder-core",
    source_repository: "oaslananka/otonom",
    base_sha: "0123456789abcdef0123456789abcdef01234567",
    objectives: ["Add webhook replay log"],
    allowed_write_paths: ["src/webhooks/**"],
    forbidden_write_paths: [],
    acceptance_criteria: ["Tests pass"],
    verification_profile: "lane",
    risk_classification: "LOW"
  }

  const mockResult = {
    task_id: "webhook-durability",
    lane: "webhook-durability",
    base_sha: "0123456789abcdef0123456789abcdef01234567",
    status: "PASS",
    model_used: "free-model-zen-flash",
    changed_paths: ["src/webhooks/replay.ts"],
    verification_results: [
      {
        profile: "lane",
        command: "node -e 'process.exit(0)'",
        exit_code: 0,
        passed: true,
        duration_ms: 100
      }
    ],
    test_summary: { total: 5, passed: 5, failed: 0, skipped: 0 },
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

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "finalizer-test-"))
    taskPath = path.join(tempDir, "task.json")
    resultPath = path.join(tempDir, "result.json")

    fs.writeFileSync(taskPath, JSON.stringify(mockTask, null, 2))
    fs.writeFileSync(resultPath, JSON.stringify(mockResult, null, 2))
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it("dry-run mode validates successfully without pushing", async () => {
    const config: FinalizerConfig = {
      taskPath,
      resultPath,
      workspaceRoot: tempDir,
      dryRun: true,
      workflowRunId: "987654"
    }

    const finalizer = new Finalizer(config)
    const report = await finalizer.execute()

    expect(report.success).toBe(true)
    expect(report.dryRun).toBe(true)
    expect(report.pushed).toBe(false)
    expect(report.branchName).toBe("swarm/987654/webhook-durability")
  })

  it("refuses result with ownership violation", async () => {
    // Result claims changed path outside allowed write paths
    const badResult = {
      ...mockResult,
      changed_paths: ["src/secrets/auth.ts"] // not in src/webhooks/**
    }
    fs.writeFileSync(resultPath, JSON.stringify(badResult, null, 2))

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: tempDir,
      dryRun: true,
      workflowRunId: "987654"
    })

    const report = await finalizer.execute()
    expect(report.success).toBe(false)
    expect(report.error).toMatch(/Ownership violation/)
  })

  it("refuses invalid or failing result", async () => {
    const failingResult = {
      ...mockResult,
      status: "FAIL"
    }
    fs.writeFileSync(resultPath, JSON.stringify(failingResult, null, 2))

    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot: tempDir,
      dryRun: true,
      workflowRunId: "987654"
    })

    const report = await finalizer.execute()
    expect(report.success).toBe(false)
    expect(report.error).toMatch(/Result status is not PASS/)
  })

  it("formats deterministic branch name safely", () => {
    const branch = Finalizer.formatBranchName("12345", "lane/with/slashes--and_special")
    expect(branch).toBe("swarm/12345/lane-with-slashes--and-special")
  })

  it("formats sanitized PR body with metadata only, no raw diff/code", () => {
    const prBody = Finalizer.formatPrBody(mockTask as any, mockResult as any)

    expect(prBody).toContain("## Swarm Lane Execution: webhook-durability")
    expect(prBody).toContain("- **Task ID:** webhook-durability")
    expect(prBody).toContain("- **Base SHA:** `0123456789abcdef0123456789abcdef01234567`")
    expect(prBody).toContain("- **Status:** PASS")
    expect(prBody).toContain("- **Tests Passed:** 5")
    expect(prBody).not.toContain("diff --git")
    expect(prBody).not.toContain("proprietary")
    expect(prBody).not.toContain("secret")
  })
})
