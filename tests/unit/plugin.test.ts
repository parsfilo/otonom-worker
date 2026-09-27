import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createOtonomPlugin } from "../../.opencode/plugins/otonom-harness.js"

describe("OpenCode Otonom Harness Plugin", () => {
  let tempDir: string
  let taskPath: string
  let runnerTemp: string

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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-test-"))
    taskPath = path.join(tempDir, "task.json")
    runnerTemp = path.join(tempDir, "runner-temp")
    fs.mkdirSync(runnerTemp, { recursive: true })

    fs.writeFileSync(taskPath, JSON.stringify(mockTask, null, 2))
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it("shell.env hook strips sensitive vars and injects safe CI vars", async () => {
    const plugin = createOtonomPlugin({
      taskPath,
      workspaceRoot: tempDir,
      runnerTemp
    })

    const output: { env: Record<string, string> } = {
      env: {
        USER: "runner",
        DOPPLER_TOKEN: "dp.st.secret",
        GITHUB_TOKEN: "ghp_123"
      }
    }

    await plugin.hooks["shell.env"]({}, output)

    expect(output.env.USER).toBe("runner")
    expect(output.env.DOPPLER_TOKEN).toBeUndefined()
    expect(output.env.GITHUB_TOKEN).toBeUndefined()
    expect(output.env.CI).toBe("1")
    expect(output.env.GIT_TERMINAL_PROMPT).toBe("0")
  })

  it("tool.execute.before blocks git push command", async () => {
    const plugin = createOtonomPlugin({
      taskPath,
      workspaceRoot: tempDir,
      runnerTemp
    })

    await expect(
      plugin.hooks["tool.execute.before"](
        { tool: "bash" },
        { args: { command: "git push origin main" } }
      )
    ).rejects.toThrow(/Git push is strictly forbidden/)
  })

  it("tool.execute.before blocks out-of-scope edits", async () => {
    const plugin = createOtonomPlugin({
      taskPath,
      workspaceRoot: tempDir,
      runnerTemp
    })

    await expect(
      plugin.hooks["tool.execute.before"](
        { tool: "edit" },
        { args: { filePath: "src/auth/jwt.ts" } }
      )
    ).rejects.toThrow(/Edit forbidden by task ownership/)
  })

  it("tool.execute.before permits owned edits", async () => {
    const plugin = createOtonomPlugin({
      taskPath,
      workspaceRoot: tempDir,
      runnerTemp
    })

    await expect(
      plugin.hooks["tool.execute.before"](
        { tool: "edit" },
        { args: { filePath: "src/webhooks/receiver.ts" } }
      )
    ).resolves.not.toThrow()
  })

  it("compaction hook injects task anchor into context", async () => {
    const plugin = createOtonomPlugin({
      taskPath,
      workspaceRoot: tempDir,
      runnerTemp
    })

    const output = { context: [] as string[] }
    await plugin.hooks["experimental.session.compacting"]({ sessionID: "s-123" }, output)

    expect(output.context.length).toBe(1)
    expect(output.context[0]).toContain("COMPACTED SWARM TASK ANCHOR")
    expect(output.context[0]).toContain("TASK_ID: webhook-durability")
    expect(output.context[0]).toContain("src/webhooks/**")
  })
})
