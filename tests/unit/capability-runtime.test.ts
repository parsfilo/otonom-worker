import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { CapabilityRuntimeManager } from "../../harness/runtime/capability-runtime.js"
import { prepareLane } from "../../harness/runtime/prepare-lane.js"
import { execFileSync } from "node:child_process"
import yaml from "yaml"

describe("Capability Profile Runtime Wiring & MCP Isolation", () => {
  let tempDir: string
  let manager: CapabilityRuntimeManager

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "capability-test-"))
    manager = new CapabilityRuntimeManager({
      profilesPath: path.resolve(process.cwd(), "config/capability-profiles.yaml"),
      workspaceRoot: tempDir
    })
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it("Test 1: builder-core generates Serena present, CodeGraph absent, edit allowed", () => {
    const serenaHomeDir = path.join(tempDir, "control", "serena-home")
    const config = manager.generateOpenCodeConfig("builder-core", tempDir, { serenaHomeDir })

    // Serena must be present in MCP config
    expect(config.mcp?.serena).toBeDefined()
    expect(config.mcp?.serena.type).toBe("local")
    expect(config.mcp?.serena.enabled).toBe(true)
    expect(Array.isArray(config.mcp?.serena.command)).toBe(true)
    expect(config.mcp?.serena.command).toContain(tempDir.replace(/\\/g, "/"))
    expect(config.mcp?.serena.environment).toEqual({
      SERENA_HOME: serenaHomeDir.replace(/\\/g, "/")
    })
    expect(config.mcp?.serena.env).toBeUndefined()
    expect(config.mcp?.serena.args).toBeUndefined()

    // CodeGraph must be absent for normal builders
    expect(config.mcp?.codegraph).toBeUndefined()

    // Builder must have edit permission
    expect(config.permission?.edit).toBe("allow")

    // Nested agents must be denied
    expect(config.permission?.agent).toBe("deny")
  })

  it("Test 2: ci-reviewer generates Serena absent, CodeGraph absent, edit denied (read_only)", () => {
    const config = manager.generateOpenCodeConfig("ci-reviewer", tempDir)

    // Serena and CodeGraph must be absent
    expect(config.mcp?.serena).toBeUndefined()
    expect(config.mcp?.codegraph).toBeUndefined()

    // Read only: edit must be denied
    expect(config.permission?.edit).toBe("deny")
  })

  it("Test 3: reviewer-cross-system generates CodeGraph present, Serena present, edit denied", () => {
    const config = manager.generateOpenCodeConfig("reviewer-cross-system", tempDir, {
      serenaHomeDir: path.join(tempDir, "control", "serena-home")
    })

    expect(config.mcp?.codegraph).toBeDefined()
    expect(config.mcp?.serena).toBeDefined()
    expect(config.permission?.edit).toBe("deny")
  })

  it("Test 4: security-reviewer generates CodeGraph present and edit denied", () => {
    const config = manager.generateOpenCodeConfig("security-reviewer", tempDir, {
      serenaHomeDir: path.join(tempDir, "control", "serena-home")
    })

    expect(config.mcp?.codegraph).toBeDefined()
    expect(config.permission?.edit).toBe("deny")
  })

  it("Test 5: ESLint LSP is truthfully wired for roles with native_lsp enabled", () => {
    const config = manager.generateOpenCodeConfig("builder-core", tempDir, {
      serenaHomeDir: path.join(tempDir, "control", "serena-home")
    })

    expect(config.lsp?.eslint).toBeDefined()
    expect(config.lsp?.eslint.command).toContain("vscode-eslint-language-server")
    expect(config.lsp?.typescript).toBeDefined()
  })

  it("Test 6: Context7 is wired when optional/enabled and absent when disabled", () => {
    const serenaHomeDir = path.join(tempDir, "control", "serena-home")
    const builderConfig = manager.generateOpenCodeConfig("builder-core", tempDir, { serenaHomeDir })
    expect(builderConfig.mcp?.context7).toBeUndefined()

    const optionalConfig = manager.generateOpenCodeConfig("builder-core", tempDir, {
      includeOptionalContext7: true,
      serenaHomeDir
    })
    expect(optionalConfig.mcp?.context7).toMatchObject({
      type: "local",
      enabled: true,
      command: ["npx", "-y", "ctx7@latest", "mcp"],
      environment: {}
    })

    const ciConfig = manager.generateOpenCodeConfig("ci-reviewer", tempDir)
    expect(ciConfig.mcp?.context7).toBeUndefined()
  })

  it("Test 7: Unknown capability role fails closed", () => {
    expect(() => {
      manager.generateOpenCodeConfig("untrusted-custom-role", tempDir)
    }).toThrow(/Unknown capability profile/i)
  })

  it("Test 8: reviewer CodeGraph uses valid local MCP shape", () => {
    const config = manager.generateOpenCodeConfig("reviewer-cross-system", tempDir, {
      serenaHomeDir: path.join(tempDir, "control", "serena-home")
    })

    expect(config.mcp?.codegraph).toMatchObject({
      type: "local",
      enabled: true,
      command: ["tokless", "mcp", "--workspace", tempDir.replace(/\\/g, "/")],
      environment: {
        CODEGRAPH_LOCAL_ONLY: "true"
      }
    })
  })

  it("Test 9: prepareLane writes OpenCode control files outside target repo", () => {
    const repoDir = path.join(tempDir, "target")
    const controlDir = path.join(tempDir, "harness-control", "lane")
    const manifestRelPath = `.tmp-capability-${Date.now()}-${Math.random().toString(16).slice(2)}.yaml`
    const manifestPath = path.join(process.cwd(), manifestRelPath)
    fs.mkdirSync(repoDir, { recursive: true })
    fs.writeFileSync(
      manifestPath,
      [
        "tasks:",
        "  - id: phase2-private-pr-smoke",
        "    role: builder-core",
        "    base_sha: 0000000000000000000000000000000000000000",
        "    objectives: [Reply exactly OK]",
        "    allowed_write_paths: ['README.md']",
        "    forbidden_write_paths: ['.github/**']",
        "    acceptance_criteria: [Pass]",
        "    verification_profile: targeted"
      ].join("\n")
    )

    try {
      prepareLane(manifestRelPath, "phase2-private-pr-smoke", controlDir, repoDir)
    } finally {
      fs.rmSync(manifestPath, { force: true })
    }

    const configPath = path.join(controlDir, "opencode", "opencode.json")
    expect(fs.existsSync(configPath)).toBe(true)
    expect(fs.existsSync(path.join(repoDir, ".opencode"))).toBe(false)
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
    expect(config.plugin).toHaveLength(1)
    expect(path.isAbsolute(config.plugin[0])).toBe(true)
    expect(config.plugin[0]).toBe(path.resolve(process.cwd(), ".opencode/plugins/otonom-harness.ts"))
    expect(fs.existsSync(config.plugin[0])).toBe(true)
    expect(config.mcp.context7).toBeUndefined()
    const serenaHomeDir = path.join(controlDir, "serena-home")
    const serenaConfigPath = path.join(serenaHomeDir, "serena_config.yml")
    expect(fs.existsSync(serenaConfigPath)).toBe(true)
    expect(config.mcp.serena.environment).toEqual({
      SERENA_HOME: serenaHomeDir.replace(/\\/g, "/")
    })
    const serenaConfig = yaml.parse(fs.readFileSync(serenaConfigPath, "utf-8"))
    expect(serenaConfig.project_serena_folder_location).toBe(
      `${path.join(controlDir, "serena-project-data").replace(/\\/g, "/")}/$projectFolderName/.serena`
    )
    expect(serenaConfig.gui_log_window).toBe(false)
    expect(serenaConfig.web_dashboard).toBe(false)
    expect(serenaConfig.web_dashboard_open_on_launch).toBe(false)
    expect(fs.existsSync(path.join(repoDir, ".git"))).toBe(false)
    expect(fs.readdirSync(repoDir)).toEqual([])
  }, 90000)

  it("Test 10: config preflight detects invalid legacy MCP shape", () => {
    const repoDir = path.join(tempDir, "target")
    const configDir = path.join(tempDir, "control", "opencode")
    fs.mkdirSync(repoDir, { recursive: true })
    fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true })
    fs.writeFileSync(path.join(configDir, "plugins", "otonom-harness.ts"), "export {}\n")
    const configPath = path.join(configDir, "opencode.json")
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugin: ["./plugins/otonom-harness.ts"],
          mcp: {
            serena: {
              type: "stdio",
              command: "uvx",
              args: ["serena-mcp-server"],
              env: {}
            }
          }
        },
        null,
        2
      )
    )

    const result = manager.preflightOpenCodeConfig({
      configPath,
      configDir,
      targetWorkspaceDir: repoDir,
      model: "opencode/space-bunny-free"
    })

    expect(result).toMatchObject({
      ok: false,
      category: "MCP_CONFIG_ERROR"
    })
  })

  it("Test 11: capability workspace guard rejects target pollution", () => {
    const repoDir = path.join(tempDir, "target")
    fs.mkdirSync(repoDir, { recursive: true })
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" })
    fs.writeFileSync(path.join(repoDir, "README.md"), "fixture\n")
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "ignore" })

    const baseline = (manager as any).captureWorkspaceStatus(repoDir)
    fs.mkdirSync(path.join(repoDir, ".serena"), { recursive: true })
    fs.writeFileSync(path.join(repoDir, ".serena", ".gitignore"), "*\n")

    expect(() => (manager as any).assertCapabilityWorkspaceClean(repoDir, baseline)).toThrow(
      "CAPABILITY_WORKSPACE_POLLUTION"
    )
  })

  it("Test 12: Phase-2 smoke owns exactly one markdown path", () => {
    const smokeManifest = yaml.parse(
      fs.readFileSync(path.resolve(process.cwd(), "config/lanes.phase2-smoke.yaml"), "utf-8")
    )

    expect(smokeManifest.tasks).toHaveLength(1)
    expect(smokeManifest.tasks[0].allowed_write_paths).toEqual([
      "docs/swarm-smoke/phase2-harness-validation.md"
    ])
  })
})
