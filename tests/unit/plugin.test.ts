import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { OtonomPlugin, createOtonomPlugin } from "../../.opencode/plugins/otonom-harness.js"

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

  it("records sanitized tool-attempt telemetry without tool arguments", async () => {
    const plugin = createOtonomPlugin({
      taskPath,
      workspaceRoot: tempDir,
      runnerTemp
    })

    await plugin.hooks["tool.execute.before"](
      { tool: "read" },
      { args: { filePath: "src/webhooks/private.ts", secret: "do-not-log" } }
    )
    await plugin.hooks["tool.execute.after"](
      { tool: "read", args: { filePath: "src/webhooks/private.ts" } },
      { output: "private source content" }
    )

    const telemetryPath = path.join(
      runnerTemp,
      "otonom-private",
      mockTask.id,
      "telemetry.jsonl"
    )
    const telemetry = fs.readFileSync(telemetryPath, "utf-8")
    expect(telemetry).toContain('"phase":"before"')
    expect(telemetry).toContain('"phase":"after"')
    expect(telemetry).toContain('"tool":"read"')
    expect(telemetry).not.toContain("private.ts")
    expect(telemetry).not.toContain("do-not-log")
    expect(telemetry).not.toContain("private source content")
  })

  it("records safe bash categories and numeric workspace change counts", async () => {
    const workspaceDir = path.join(tempDir, "workspace")
    fs.mkdirSync(workspaceDir, { recursive: true })
    execFileSync("git", ["init"], { cwd: workspaceDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspaceDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspaceDir, stdio: "ignore" })
    fs.writeFileSync(path.join(workspaceDir, "README.md"), "base\n")
    execFileSync("git", ["add", "."], { cwd: workspaceDir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "base"], { cwd: workspaceDir, stdio: "ignore" })
    fs.writeFileSync(taskPath, JSON.stringify({ ...mockTask, base_sha: "HEAD" }))

    const plugin = createOtonomPlugin({ taskPath, workspaceRoot: workspaceDir, runnerTemp })
    await plugin.hooks["tool.execute.before"](
      { tool: "bash" },
      { args: { command: "git status --short" } }
    )
    await plugin.hooks["tool.execute.after"](
      { tool: "bash", args: { command: "git status --short" } },
      { output: "" }
    )

    const telemetry = fs.readFileSync(
      path.join(runnerTemp, "otonom-private", mockTask.id, "telemetry.jsonl"),
      "utf-8"
    )
    expect(telemetry).toContain('"commandCategory":"git_status"')
    expect(telemetry).toContain('"workspaceChangeCount":0')
    expect(telemetry).not.toContain("git status --short")
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

  it("default OpenCode plugin exposes the real custom tool registry and reads TASK_PATH from control storage", async () => {
    const oldTaskPath = process.env.TASK_PATH
    const oldResultPath = process.env.RESULT_PATH
    const oldPrivateDir = process.env.PRIVATE_DIR
    const oldLane = process.env.LANE_ID
    const controlDir = path.join(tempDir, "control")
    fs.mkdirSync(controlDir, { recursive: true })
    const controlTaskPath = path.join(controlDir, "task.json")
    fs.copyFileSync(taskPath, controlTaskPath)
    process.env.TASK_PATH = controlTaskPath
    process.env.RESULT_PATH = path.join(controlDir, "result.json")
    process.env.PRIVATE_DIR = path.join(tempDir, "private")
    process.env.LANE_ID = "webhook-durability"

    try {
      const hooks: any = await OtonomPlugin({ directory: tempDir } as any)
      expect(Object.keys(hooks.tool).sort()).toEqual([
        "complete_lane",
        "cross_lane_request",
        "record_finding",
        "run_verification",
        "task_context"
      ])
      const context = JSON.parse(await hooks.tool.task_context.execute({}, {} as any))
      expect(context.id).toBe("webhook-durability")
      expect(context.allowed_write_paths).toEqual(["src/webhooks/**"])
    } finally {
      if (oldTaskPath === undefined) delete process.env.TASK_PATH
      else process.env.TASK_PATH = oldTaskPath
      if (oldResultPath === undefined) delete process.env.RESULT_PATH
      else process.env.RESULT_PATH = oldResultPath
      if (oldPrivateDir === undefined) delete process.env.PRIVATE_DIR
      else process.env.PRIVATE_DIR = oldPrivateDir
      if (oldLane === undefined) delete process.env.LANE_ID
      else process.env.LANE_ID = oldLane
    }
  })


  it("blocks dependency-mutating package-manager commands when lockfiles are outside lane ownership", async () => {
    const plugin: any = createOtonomPlugin({ taskPath, workspaceRoot: tempDir })
    await expect(
      plugin.hooks["tool.execute.before"](
        { tool: "bash" },
        { args: { command: "pnpm install" } }
      )
    ).rejects.toThrow("Dependency mutation blocked")
  })


  it("blocks web/subagent tools and external reads in the plugin policy layer", async () => {
    const plugin: any = createOtonomPlugin({ taskPath, workspaceRoot: tempDir })
    await expect(plugin.hooks["tool.execute.before"]({ tool: "webfetch" }, { args: { url: "https://example.com" } })).rejects.toThrow("Tool blocked")
    await expect(plugin.hooks["tool.execute.before"]({ tool: "task" }, { args: {} })).rejects.toThrow("Tool blocked")
    await expect(plugin.hooks["tool.execute.before"]({ tool: "read" }, { args: { filePath: "/etc/passwd" } })).rejects.toThrow("workspace boundary")
  })

})
