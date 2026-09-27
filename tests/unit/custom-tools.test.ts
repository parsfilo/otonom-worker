import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { TaskContextTool } from "../../.opencode/tools/task-context.js"
import { RecordFindingTool } from "../../.opencode/tools/record-finding.js"
import { CrossLaneRequestTool } from "../../.opencode/tools/cross-lane-request.js"
import { RunVerificationTool } from "../../.opencode/tools/run-verification.js"
import { CompleteLaneTool } from "../../.opencode/tools/complete-lane.js"

describe("OpenCode Custom Tools", () => {
  let tempDir: string
  let taskPath: string
  let privateDir: string

  const mockTask = {
    id: "webhook-durability",
    title: "Webhook durability",
    role: "builder-core",
    source_repository: "oaslananka/otonom",
    base_sha: "0123456789abcdef0123456789abcdef01234567",
    objectives: ["Add webhook replay log"],
    allowed_write_paths: ["src/webhooks/**"],
    acceptance_criteria: ["Tests pass"],
    verification_profile: "lane",
    risk_classification: "LOW"
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tools-test-"))
    taskPath = path.join(tempDir, "task.json")
    privateDir = path.join(tempDir, "private")
    fs.mkdirSync(privateDir, { recursive: true })

    fs.writeFileSync(taskPath, JSON.stringify(mockTask, null, 2))
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it("task_context returns structured task data without secrets", async () => {
    const tool = new TaskContextTool(taskPath)
    const context = await tool.execute()

    expect(context.id).toBe("webhook-durability")
    expect(context.role).toBe("builder-core")
    expect(context.base_sha).toBe("0123456789abcdef0123456789abcdef01234567")
    expect(context.allowed_write_paths).toEqual(["src/webhooks/**"])
    expect(context).not.toHaveProperty("DOPPLER_TOKEN")
    expect(context).not.toHaveProperty("GITHUB_TOKEN")
  })

  it("record_finding writes valid finding to private findings file", async () => {
    const tool = new RecordFindingTool(privateDir)
    const res = await tool.execute({
      id: "find-audit-1",
      severity: "HIGH",
      path: "src/webhooks/receiver.ts",
      summary: "Missing replay protection",
      evidence: "Handler does not check idempotency table",
      status: "open"
    })

    expect(res.success).toBe(true)
    const findingsFile = path.join(privateDir, "findings.json")
    expect(fs.existsSync(findingsFile)).toBe(true)
    const data = JSON.parse(fs.readFileSync(findingsFile, "utf-8"))
    expect(data.length).toBe(1)
    expect(data[0].id).toBe("find-audit-1")
  })

  it("cross_lane_request writes valid request to private storage", async () => {
    const tool = new CrossLaneRequestTool(privateDir, "webhook-durability")
    const res = await tool.execute({
      id: "clr-db-01",
      target_lane: "db-migrations",
      requested_path: "prisma/schema.prisma",
      justification: "Need unique constraint on idempotency key",
      proposed_change_description: "Add idempotencyKey column"
    })

    expect(res.success).toBe(true)
    const reqFile = path.join(privateDir, "cross-lane-requests.json")
    expect(fs.existsSync(reqFile)).toBe(true)
    const data = JSON.parse(fs.readFileSync(reqFile, "utf-8"))
    expect(data.length).toBe(1)
    expect(data[0].requesting_lane).toBe("webhook-durability")
  })

  it("run_verification executes named profile safely", async () => {
    const tool = new RunVerificationTool({
      customProfiles: {
        lane: "node -e 'process.exit(0)'"
      }
    })

    const result = await tool.execute({ profile: "lane" })
    expect(result.passed).toBe(true)
    expect(result.exit_code).toBe(0)
  })

  it("complete_lane refuses completion when requirements are unmet", async () => {
    const tool = new CompleteLaneTool({
      taskPath,
      privateDir,
      workspaceRoot: tempDir
    })

    // No verification run yet
    const attempt = await tool.execute()
    expect(attempt.completed).toBe(false)
    expect(attempt.error).toBeDefined()
  })
})
