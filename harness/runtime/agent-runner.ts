import { spawn, ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { assertAgentSecretBoundary, FORBIDDEN_ENV_VARS } from "../policies/secret-boundary.js"

export type AgentExecutionStatus =
  | "PASS"
  | "FAIL"
  | "STALLED"
  | "RATE_LIMITED"
  | "UNAVAILABLE"

export interface AgentRunnerOptions {
  laneId: string
  privateDir: string
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  onPublicLog?: (message: string) => void
}

export interface AgentRunResult {
  exitCode: number | null
  status: AgentExecutionStatus
  durationMs: number
  timedOut: boolean
  stalled: boolean
  stdoutPath: string
  stderrPath: string
  sanitizedSummary: string
  errorCategory?: string
}

export class AgentRunner {
  private laneId: string
  private privateDir: string
  private command: string
  private args: string[]
  private cwd?: string
  private env?: Record<string, string>
  private timeoutMs: number
  private onPublicLog: (message: string) => void

  constructor(options: AgentRunnerOptions) {
    this.laneId = options.laneId
    this.privateDir = path.resolve(options.privateDir)
    this.command = options.command || "opencode"
    this.args = options.args || []
    this.cwd = options.cwd
    this.env = options.env
    this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1000 // default 30 min
    this.onPublicLog = options.onPublicLog || ((msg) => console.log(msg))
  }

  public async run(): Promise<AgentRunResult> {
    fs.mkdirSync(this.privateDir, { recursive: true })

    const stdoutPath = path.join(this.privateDir, "opencode.stdout.log")
    const stderrPath = path.join(this.privateDir, "opencode.stderr.log")

    const stdoutStream = fs.createWriteStream(stdoutPath, { flags: "w" })
    const stderrStream = fs.createWriteStream(stderrPath, { flags: "w" })

    const startTime = Date.now()
    let timedOut = false
    let killed = false

    this.onPublicLog(
      `[OTONOM-HARNESS] Starting agent execution for lane '${this.laneId}' (storage: private runner-local)`
    )

    const effectiveEnv: Record<string, string | undefined> = {
      ...(this.env ? { ...process.env, ...this.env } : process.env)
    }

    // Explicitly scrub forbidden tokens so they are never inherited by the agent
    for (const forbidden of FORBIDDEN_ENV_VARS) {
      delete effectiveEnv[forbidden]
    }

    // Live boundary check: asserts env and git config contain zero forbidden credentials
    assertAgentSecretBoundary(effectiveEnv, this.cwd)

    return new Promise<AgentRunResult>((resolve) => {
      const child: ChildProcess = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: effectiveEnv as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      })

      // Pipe child stdout & stderr EXCLUSIVELY to private log streams
      if (child.stdout) {
        child.stdout.pipe(stdoutStream)
      }
      if (child.stderr) {
        child.stderr.pipe(stderrStream)
      }

      const timer = setTimeout(() => {
        timedOut = true
        killed = true
        this.killProcessTree(child)
      }, this.timeoutMs)

      child.on("error", (err) => {
        clearTimeout(timer)
        stdoutStream.end()
        stderrStream.end()

        const durationMs = Date.now() - startTime
        const status: AgentExecutionStatus = "FAIL"
        const summary = `[OTONOM-HARNESS] Lane '${this.laneId}' execution error: ${err.name}`
        this.onPublicLog(summary)

        resolve({
          exitCode: 1,
          status,
          durationMs,
          timedOut: false,
          stalled: false,
          stdoutPath,
          stderrPath,
          sanitizedSummary: summary,
          errorCategory: "PROCESS_ERROR"
        })
      })

      child.on("close", (code) => {
        clearTimeout(timer)
        stdoutStream.end(() => {
          stderrStream.end(() => {
            const durationMs = Date.now() - startTime
            const classification = this.classifyExecution(
              code,
              timedOut,
              stdoutPath,
              stderrPath
            )

            const summary = `[OTONOM-HARNESS] Lane '${this.laneId}' completed with status: ${classification.status} (exitCode: ${code}, duration: ${durationMs}ms)`
            this.onPublicLog(summary)

            resolve({
              exitCode: code,
              status: classification.status,
              durationMs,
              timedOut,
              stalled: timedOut,
              stdoutPath,
              stderrPath,
              sanitizedSummary: summary,
              errorCategory: classification.errorCategory
            })
          })
        })
      })
    })
  }

  private killProcessTree(child: ChildProcess) {
    try {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", child.pid.toString(), "/T", "/F"], {
          stdio: "ignore"
        })
      } else {
        child.kill("SIGKILL")
      }
    } catch {
      // process might already have exited
    }
  }

  private classifyExecution(
    exitCode: number | null,
    timedOut: boolean,
    stdoutPath: string,
    stderrPath: string
  ): { status: AgentExecutionStatus; errorCategory?: string } {
    if (timedOut) {
      return { status: "STALLED", errorCategory: "TIMEOUT" }
    }

    if (exitCode === 0) {
      return { status: "PASS" }
    }

    // Inspect private logs without exposing them to determine error classification
    let logHeadAndTail = ""
    try {
      if (fs.existsSync(stderrPath)) {
        const errContent = fs.readFileSync(stderrPath, "utf-8")
        logHeadAndTail += errContent.slice(0, 4096) + "\n" + errContent.slice(-4096)
      }
      if (fs.existsSync(stdoutPath)) {
        const outContent = fs.readFileSync(stdoutPath, "utf-8")
        logHeadAndTail += "\n" + outContent.slice(-4096)
      }
    } catch {
      // fallback to generic failure
    }

    const rateLimitRegex =
      /(?:429|rate[\s_-]*limit|quota[\s_-]*exceeded|too many requests)/i
    if (rateLimitRegex.test(logHeadAndTail)) {
      return { status: "RATE_LIMITED", errorCategory: "RATE_LIMITED" }
    }

    const pluginRegex =
      /(?:plugin.*(?:not found|load|failed|error)|Cannot find module.*plugin|failed.*plugin)/i
    if (pluginRegex.test(logHeadAndTail)) {
      return { status: "FAIL", errorCategory: "PLUGIN_LOAD_ERROR" }
    }

    const mcpConfigRegex =
      /(?:Missing key mcp\.|Expected type "local"|"remote"|invalid.*mcp|mcp.*schema)/i
    if (mcpConfigRegex.test(logHeadAndTail)) {
      return { status: "FAIL", errorCategory: "MCP_CONFIG_ERROR" }
    }

    const configRegex =
      /(?:config.*invalid|invalid.*config|failed to parse.*config|configuration.*(?:parse|invalid))/i
    if (configRegex.test(logHeadAndTail)) {
      return { status: "FAIL", errorCategory: "CONFIG_INVALID" }
    }

    const mcpStartRegex =
      /(?:mcp.*(?:start|spawn|connect).*failed|failed to start.*mcp|mcp.*connection)/i
    if (mcpStartRegex.test(logHeadAndTail)) {
      return { status: "FAIL", errorCategory: "MCP_START_ERROR" }
    }

    const unavailableRegex =
      /(?:model.*not found|model.*unavailable|does not exist|model.*not supported|unknown.*model|unknownerror|unexpected.*server.*error|provider.*not.*found|failed to fetch|econnrefused|endpoint\s+(?:is\s+)?unavailable|upstream request failed.*unavailable|service unavailable|temporarily unavailable|model access is disabled|model.*access.*disabled)/i
    if (unavailableRegex.test(logHeadAndTail)) {
      return { status: "UNAVAILABLE", errorCategory: "MODEL_UNAVAILABLE" }
    }

    return { status: "FAIL", errorCategory: "NON_ZERO_EXIT" }
  }
}
