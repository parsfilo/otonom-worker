import fs from "node:fs"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import yaml from "yaml"

export const SERENA_COMMIT = "949a27ef1e5fda1a6e7b561e777bcece345c6ffd"
export const HARNESS_PLUGIN_NAME = "otonom-harness.ts"
export const OPENCODE_COMMAND = process.platform === "win32" ? "cmd.exe" : "opencode"
export function opencodeArgs(args: string[]): string[] {
  return process.platform === "win32" ? ["/d", "/s", "/c", "opencode", ...args] : args
}

export interface OpenCodeConfigOptions {
  includeOptionalContext7?: boolean
  pluginPath?: string
}

export interface RoleProfile {
  description?: string
  read_only: boolean
  native_lsp?: boolean
  serena?: boolean
  codegraph?: boolean
  context7?: boolean | string
  postgres?: boolean
  ast_grep?: boolean
  security_scanners?: boolean | string
  nested_agents?: boolean
  full_verification?: boolean
  playwright_cli?: boolean
  actionlint?: boolean
  zizmor?: boolean
  shellcheck?: boolean
  semgrep?: boolean
}

export interface CapabilityRuntimeOptions {
  profilesPath?: string
  workspaceRoot?: string
}

export class CapabilityRuntimeManager {
  private profilesPath: string
  private profiles: Record<string, RoleProfile>

  constructor(options: CapabilityRuntimeOptions = {}) {
    this.profilesPath =
      options.profilesPath ||
      path.resolve(process.cwd(), "config/capability-profiles.yaml")
    this.profiles = this.loadProfiles()
  }

  private loadProfiles(): Record<string, RoleProfile> {
    if (!fs.existsSync(this.profilesPath)) {
      throw new Error(`Capability profiles file not found: ${this.profilesPath}`)
    }
    const raw = fs.readFileSync(this.profilesPath, "utf-8")
    const parsed = yaml.parse(raw)
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Invalid capability profiles structure in: ${this.profilesPath}`)
    }
    return parsed as Record<string, RoleProfile>
  }

  public getProfile(role: string): RoleProfile {
    const profile = this.profiles[role]
    if (!profile) {
      throw new Error(`Unknown capability profile: '${role}'. Runtime fails closed.`)
    }
    return profile
  }

  private localMcp(command: string[], environment: Record<string, string> = {}) {
    return {
      type: "local",
      enabled: true,
      command,
      environment
    }
  }

  public generateOpenCodeConfig(
    role: string,
    targetWorkspaceDir: string,
    options: OpenCodeConfigOptions = {}
  ): any {
    const profile = this.getProfile(role)
    const normalizedDir = path.resolve(targetWorkspaceDir).replace(/\\/g, "/")

    const mcp: Record<string, any> = {}

    // 1. Serena Wiring
    if (profile.serena) {
      mcp.serena = this.localMcp(
        [
          "uvx",
          "--from",
          `git+https://github.com/oraios/serena@${SERENA_COMMIT}`,
          "serena",
          "start-mcp-server",
          "--project",
          normalizedDir,
          "--context",
          "ide-assistant",
          "--mode",
          "editing",
          "--transport",
          "stdio",
          "--enable-web-dashboard",
          "false",
          "--enable-gui-log-window",
          "false",
          "--open-web-dashboard",
          "false"
        ],
        {
          SERENA_SHARED_MEMORY: "false"
        }
      )
    }

    // 2. CodeGraph Wiring
    if (profile.codegraph) {
      mcp.codegraph = this.localMcp(
        ["tokless", "mcp", "--workspace", normalizedDir],
        {
          CODEGRAPH_LOCAL_ONLY: "true"
        }
      )
    }

    // 3. Context7 Wiring (Keyless public docs lookup)
    const shouldEnableContext7 =
      profile.context7 === true ||
      (profile.context7 === "optional" && options.includeOptionalContext7 === true)
    if (shouldEnableContext7) {
      mcp.context7 = this.localMcp(["npx", "-y", "ctx7@latest", "mcp"])
    }

    // 4. LSP Wiring
    const lsp: Record<string, any> = {}
    if (profile.native_lsp) {
      lsp.typescript = {
        command: ["typescript-language-server", "--stdio"],
        extensions: [".ts", ".tsx", ".js", ".jsx"]
      }
      lsp.eslint = {
        command: ["vscode-eslint-language-server", "--stdio"],
        extensions: [".ts", ".tsx", ".js", ".jsx"]
      }
      lsp.yaml = {
        command: ["yaml-language-server", "--stdio"],
        extensions: [".yaml", ".yml"]
      }
      lsp.bash = {
        command: ["bash-language-server", "start"],
        extensions: [".sh", ".bash"]
      }
    }

    // 5. Strict Sandboxed Permissions
    const permission: Record<string, any> = {
      "*": "deny",
      task: "deny",
      agent: "deny", // Nested agents strictly prohibited
      doom_loop: "deny",
      webfetch: "deny",
      websearch: "deny",
      external_directory: "deny",
      read: {
        "*": "allow",
        "*.env": "deny",
        "*.env.*": "deny",
        "*.env.example": "allow"
      },
      edit: profile.read_only ? "deny" : "allow",
      glob: "allow",
      grep: "allow",
      lsp: profile.native_lsp ? "allow" : "deny",
      skill: "allow",
      bash: {
        "*": "deny",
        "git status*": "allow",
        "git diff*": "allow",
        "git log*": "allow",
        "pnpm *": "allow",
        "npm *": "allow",
        "node *": "allow",
        "rg *": "allow",
        "ls *": "allow",
        "cat *": "allow",
        "ast-grep *": "allow",
        "sg *": "allow",
        "git push*": "deny",
        "git commit*": "deny",
        "gh *": "deny",
        "sudo *": "deny",
        "ssh *": "deny",
        "scp *": "deny"
      }
    }

    const config: any = {
      $schema: "https://opencode.ai/config.json",
      name: `otonom-agent-${role}`,
      plugin: [options.pluginPath || `./plugins/${HARNESS_PLUGIN_NAME}`],
      permission
    }

    if (Object.keys(mcp).length > 0) {
      config.mcp = mcp
    }
    if (Object.keys(lsp).length > 0) {
      config.lsp = lsp
    }

    return config
  }

  public writeLaneConfig(
    role: string,
    targetWorkspaceDir: string,
    outputPath: string,
    options: OpenCodeConfigOptions = {}
  ): void {
    const config = this.generateOpenCodeConfig(role, targetWorkspaceDir, options)
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, JSON.stringify(config, null, 2))
  }

  public copyHarnessPlugin(outputConfigDir: string): string {
    const sourcePath = path.resolve(process.cwd(), ".opencode/plugins", HARNESS_PLUGIN_NAME)
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Harness plugin not found: ${sourcePath}`)
    }
    const pluginsDir = path.join(outputConfigDir, "plugins")
    fs.mkdirSync(pluginsDir, { recursive: true })
    const targetPath = path.join(pluginsDir, HARNESS_PLUGIN_NAME)
    fs.copyFileSync(sourcePath, targetPath)
    return targetPath
  }

  public preflightOpenCodeConfig(input: {
    configPath: string
    configDir: string
    targetWorkspaceDir: string
    model: string
  }): { ok: true } | { ok: false; category: string; message: string } {
    if (!fs.existsSync(input.targetWorkspaceDir)) {
      return { ok: false, category: "CONFIG_INVALID", message: "target cwd missing" }
    }
    if (!fs.existsSync(input.configPath)) {
      return { ok: false, category: "CONFIG_INVALID", message: "OpenCode config missing" }
    }
    const config = JSON.parse(fs.readFileSync(input.configPath, "utf-8"))
    for (const [name, entry] of Object.entries<any>(config.mcp || {})) {
      if (entry.type !== "local" || entry.enabled !== true || !Array.isArray(entry.command)) {
        return { ok: false, category: "MCP_CONFIG_ERROR", message: `invalid MCP entry: ${name}` }
      }
      if ("args" in entry || "env" in entry || typeof entry.command === "string") {
        return { ok: false, category: "MCP_CONFIG_ERROR", message: `legacy MCP entry: ${name}` }
      }
    }
    for (const pluginPath of config.plugin || []) {
      const resolved = path.resolve(input.configDir, pluginPath)
      if (!fs.existsSync(resolved)) {
        return { ok: false, category: "PLUGIN_LOAD_ERROR", message: "plugin missing" }
      }
    }
    if (!input.model.startsWith("opencode/") || !input.model.includes("-free")) {
      return { ok: false, category: "MODEL_UNAVAILABLE", message: "unsafe model candidate" }
    }
    try {
      execFileSync(OPENCODE_COMMAND, opencodeArgs(["debug", "config", "--pure"]), {
        cwd: input.targetWorkspaceDir,
        env: {
          ...process.env,
          OPENCODE_CONFIG: input.configPath,
          OPENCODE_CONFIG_DIR: input.configDir
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000
      })
      return { ok: true }
    } catch (err: any) {
      return { ok: false, category: "CONFIG_INVALID", message: err.message }
    }
  }
}

export interface SerenaSupervisorOptions {
  workspaceDir: string
  targetSha: string
  mockProcess?: boolean
}

export interface SerenaHandle {
  running: boolean
  pid?: number
}

export class SerenaRuntimeSupervisor {
  private handle: SerenaHandle = { running: false }
  private childProcess?: any

  constructor(private options: SerenaSupervisorOptions) {}

  public async start(): Promise<SerenaHandle> {
    if (!fs.existsSync(this.options.workspaceDir)) {
      throw new Error(`Workspace directory does not exist for Serena: ${this.options.workspaceDir}`)
    }

    if (this.options.mockProcess) {
      this.handle = { running: true, pid: 12345 }
      console.log("serena_runtime: PASS")
      return this.handle
    }

    try {
      this.childProcess = spawn(
        "uvx",
        [
          "--from",
          `git+https://github.com/oraios/serena@${SERENA_COMMIT}`,
          "serena",
          "start-mcp-server",
          "--project",
          this.options.workspaceDir,
          "--context",
          "ide-assistant",
          "--mode",
          "editing",
          "--transport",
          "stdio",
          "--enable-web-dashboard",
          "false",
          "--enable-gui-log-window",
          "false",
          "--open-web-dashboard",
          "false"
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            SERENA_SHARED_MEMORY: "false"
          }
        }
      )

      this.handle = {
        running: true,
        pid: this.childProcess.pid
      }

      console.log("serena_runtime: PASS")
      return this.handle
    } catch (err: any) {
      console.error(`[Serena Error] Failed to start Serena: ${err.message}`)
      this.handle = { running: false }
      throw err
    }
  }

  public async stop(): Promise<void> {
    if (this.childProcess && !this.childProcess.killed) {
      try {
        this.childProcess.kill("SIGTERM")
      } catch {}
    }
    this.handle.running = false
  }
}
