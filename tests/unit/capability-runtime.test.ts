import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { CapabilityRuntimeManager } from "../../harness/runtime/capability-runtime.js"

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
    const config = manager.generateOpenCodeConfig("builder-core", tempDir)

    // Serena must be present in MCP config
    expect(config.mcp?.serena).toBeDefined()
    expect(config.mcp?.serena.args).toContain(tempDir.replace(/\\/g, "/"))

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
    const config = manager.generateOpenCodeConfig("reviewer-cross-system", tempDir)

    expect(config.mcp?.codegraph).toBeDefined()
    expect(config.mcp?.serena).toBeDefined()
    expect(config.permission?.edit).toBe("deny")
  })

  it("Test 4: security-reviewer generates CodeGraph present and edit denied", () => {
    const config = manager.generateOpenCodeConfig("security-reviewer", tempDir)

    expect(config.mcp?.codegraph).toBeDefined()
    expect(config.permission?.edit).toBe("deny")
  })

  it("Test 5: ESLint LSP is truthfully wired for roles with native_lsp enabled", () => {
    const config = manager.generateOpenCodeConfig("builder-core", tempDir)

    expect(config.lsp?.eslint).toBeDefined()
    expect(config.lsp?.eslint.command).toContain("vscode-eslint-language-server")
    expect(config.lsp?.typescript).toBeDefined()
  })

  it("Test 6: Context7 is wired when optional/enabled and absent when disabled", () => {
    const builderConfig = manager.generateOpenCodeConfig("builder-core", tempDir)
    expect(builderConfig.mcp?.context7).toBeDefined()

    const ciConfig = manager.generateOpenCodeConfig("ci-reviewer", tempDir)
    expect(ciConfig.mcp?.context7).toBeUndefined()
  })

  it("Test 7: Unknown capability role fails closed", () => {
    expect(() => {
      manager.generateOpenCodeConfig("untrusted-custom-role", tempDir)
    }).toThrow(/Unknown capability profile/i)
  })
})
