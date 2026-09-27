import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { CapabilityRuntimeManager } from "../../harness/runtime/capability-runtime.js"

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
    const serenaHomeDir = path.join(tempDir, "control", "serena-home")
    const config = manager.generateOpenCodeConfig("builder-core", tempDir, { serenaHomeDir })

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
    expect(serenaMcp.environment).toEqual({
      SERENA_HOME: serenaHomeDir.replace(/\\/g, "/")
    })
    expect(serenaMcp.env).toBeUndefined()
  })

  it("keeps pinned Serena project initialization outside the target repository", () => {
    const manager = new CapabilityRuntimeManager()
    const repoDir = path.join(tempDir, "target-project")
    const controlDir = path.join(tempDir, "control")
    fs.mkdirSync(repoDir, { recursive: true })
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" })
    fs.writeFileSync(path.join(repoDir, "README.md"), "fixture\n")
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "ignore" })

    const runtime = (manager as any).prepareSerenaHome(controlDir)
    const config = manager.generateOpenCodeConfig("builder-core", repoDir, {
      serenaHomeDir: runtime.homeDir
    })
    const command = config.mcp.serena.command as string[]
    execFileSync(command[0], [...command.slice(1, 4), "project", "create", repoDir], {
      cwd: repoDir,
      env: { ...process.env, ...config.mcp.serena.environment },
      stdio: "ignore",
      timeout: 60000
    })

    const projectDataDir = path.join(
      controlDir,
      "serena-project-data",
      path.basename(repoDir),
      ".serena"
    )
    expect(fs.existsSync(path.join(projectDataDir, "project.yml"))).toBe(true)
    expect(fs.existsSync(path.join(repoDir, ".serena"))).toBe(false)
    expect(
      execFileSync("git", ["status", "--porcelain=v1", "-uall"], {
        cwd: repoDir,
        encoding: "utf-8"
      })
    ).toBe("")
  }, 90000)

  it("uses OpenCode as the only Serena MCP server launch path", () => {
    const manager = new CapabilityRuntimeManager()
    const config = manager.generateOpenCodeConfig("builder-core", tempDir, {
      serenaHomeDir: path.join(tempDir, "control", "serena-home")
    })
    const runLaneSource = fs.readFileSync(
      path.resolve(process.cwd(), "harness/runtime/run-lane.ts"),
      "utf-8"
    )

    expect(config.mcp.serena.command.filter((part: string) => part === "start-mcp-server")).toHaveLength(1)
    expect(runLaneSource).not.toContain("SerenaRuntimeSupervisor")
    expect(runLaneSource).not.toContain("start-mcp-server")
  })
})
