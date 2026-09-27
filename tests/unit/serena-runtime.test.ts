import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { CapabilityRuntimeManager, SerenaRuntimeSupervisor } from "../../harness/runtime/capability-runtime.js"

describe("Serena Runtime Wiring & Lifecycle", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "serena-test-"))
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it("configures Serena MCP in OpenCode config with pinned commit and workspace binding", () => {
    const manager = new CapabilityRuntimeManager()
    const config = manager.generateOpenCodeConfig("builder-core", tempDir)

    expect(config.mcp).toBeDefined()
    expect(config.mcp.serena).toBeDefined()
    const serenaMcp = config.mcp.serena
    expect(serenaMcp.type).toBe("local")
    expect(serenaMcp.enabled).toBe(true)
    expect(serenaMcp.command).toContain(tempDir.replace(/\\/g, "/"))
    expect(serenaMcp.command).toEqual(
      expect.arrayContaining([expect.stringContaining("949a27ef1e5fda1a6e7b561e777bcece345c6ffd")])
    )
    expect(serenaMcp.command).toEqual(expect.arrayContaining(["serena", "start-mcp-server", "--project"]))
    expect(serenaMcp.command).not.toContain("serena-mcp-server")
    expect(serenaMcp.environment.SERENA_SHARED_MEMORY).toBe("false")
    expect(serenaMcp.env).toBeUndefined()
  })

  it("supervises Serena lifecycle and logs serena_runtime: PASS safely", async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(msg)
    })

    const supervisor = new SerenaRuntimeSupervisor({
      workspaceDir: tempDir,
      targetSha: "abc1234567890def1234567890def1234567890",
      mockProcess: true
    })

    const handle = await supervisor.start()
    expect(handle.running).toBe(true)

    await supervisor.stop()
    expect(handle.running).toBe(false)

    logSpy.mockRestore()

    expect(logs).toContain("serena_runtime: PASS")
    // Assert no raw source code or indexing internals are logged publicly
    const publicLogText = logs.join("\n")
    expect(publicLogText).not.toContain("index_symbols")
    expect(publicLogText).not.toContain("ast_tokens")
  })
})
