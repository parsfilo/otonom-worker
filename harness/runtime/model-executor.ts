import { ModelSelector } from "./model-selector.js"
import { AgentRunner, AgentRunResult, AgentExecutionStatus } from "./agent-runner.js"
import { CapabilityRuntimeManager, OPENCODE_COMMAND, opencodeArgs } from "./capability-runtime.js"
import { GitChangeDetector } from "../finalizer/git-detector.js"
import path from "node:path"
import fs from "node:fs"
import { execFileSync } from "node:child_process"

export interface ModelExecutorOptions {
  selector?: ModelSelector
  runnerFactory?: (model: string) => { run: () => Promise<AgentRunResult> }
  maxAttempts?: number
  privateDir?: string
  workspaceDir?: string
  opencodeConfigPath?: string
  opencodeConfigDir?: string
  agentEnv?: Record<string, string>
  requiresChanges?: boolean
  baseSha?: string
  completionResultPath?: string
  requireCompletionResult?: boolean
  attemptTimeoutMs?: number
}

export interface ModelExecutionAttempt {
  model: string
  status: AgentExecutionStatus
  durationMs: number
  errorCategory?: string
}

export interface ModelExecutionResult {
  success: boolean
  status: AgentExecutionStatus
  actualModel?: string
  attempts: ModelExecutionAttempt[]
  lastResult?: AgentRunResult
  error?: string
}


interface AttemptTelemetrySummary {
  events: number
  attempted: Map<string, number>
  completed: Map<string, number>
  attemptedBashCategories: Map<string, number>
  sessionErrors: number
  changeTrace: string[]
  idleState?: {
    pendingToolCount: number
    pendingMutationCount: number
    pendingOwnedMutationCount: number
    workspaceChangeCount: number
    ownedChangeCount: number
    unownedChangeCount: number
    pendingBashCategories: string[]
  }
}

function countByTool(events: Array<Record<string, unknown>>, phase: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const event of events) {
    if (event.phase !== phase || typeof event.tool !== "string") continue
    counts.set(event.tool, (counts.get(event.tool) || 0) + 1)
  }
  return counts
}

function readAttemptTelemetry(telemetryPath: string, startOffset: number): AttemptTelemetrySummary {
  if (!fs.existsSync(telemetryPath)) {
    return {
      events: 0,
      attempted: new Map(),
      completed: new Map(),
      attemptedBashCategories: new Map(),
      sessionErrors: 0,
      changeTrace: []
    }
  }

  const content = fs.readFileSync(telemetryPath).subarray(startOffset).toString("utf-8")
  const events: Array<Record<string, unknown>> = []
  for (const line of content.split("\n")) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === "object") events.push(parsed)
    } catch {
      // Ignore malformed private telemetry; diagnostics must never affect execution.
    }
  }

  const changeTrace = events
    .filter(
      (event) =>
        ["before", "after", "event"].includes(String(event.phase)) &&
        (typeof event.workspaceChangeCount === "number" || event.event === "session.idle")
    )
    .slice(0, 64)
    .map((event) => {
      if (event.phase === "event") {
        return [
          "idle",
          String(event.workspaceChangeCount ?? -1),
          String(event.ownedChangeCount ?? -1),
          String(event.unownedChangeCount ?? -1),
          "p" + String(event.pendingToolCount ?? -1),
          "m" + String(event.pendingMutationCount ?? -1)
        ].join(":")
      }
      const category =
        event.tool === "bash" && typeof event.commandCategory === "string"
          ? "[" + event.commandCategory + "]"
          : ""
      return [
        String(event.phase),
        String(event.tool),
        category,
        String(event.workspaceChangeCount ?? -1),
        String(event.ownedChangeCount ?? -1),
        String(event.unownedChangeCount ?? -1)
      ].join(":")
    })

  const attemptedBashCategories = new Map<string, number>()
  for (const event of events) {
    if (event.phase !== "before" || event.tool !== "bash" || typeof event.commandCategory !== "string") continue
    attemptedBashCategories.set(
      event.commandCategory,
      (attemptedBashCategories.get(event.commandCategory) || 0) + 1
    )
  }

  const idle = [...events]
    .reverse()
    .find((event) => event.phase === "event" && event.event === "session.idle")

  return {
    events: events.length,
    attempted: countByTool(events, "before"),
    completed: countByTool(events, "after"),
    attemptedBashCategories,
    sessionErrors: events.filter((event) => event.phase === "event" && event.event === "session.error").length,
    changeTrace,
    idleState: idle
      ? {
          pendingToolCount: Number(idle.pendingToolCount || 0),
          pendingMutationCount: Number(idle.pendingMutationCount || 0),
          pendingOwnedMutationCount: Number(idle.pendingOwnedMutationCount || 0),
          workspaceChangeCount: Number(idle.workspaceChangeCount || 0),
          ownedChangeCount: Number(idle.ownedChangeCount || 0),
          unownedChangeCount: Number(idle.unownedChangeCount || 0),
          pendingBashCategories: Array.isArray(idle.pendingBashCategories)
            ? idle.pendingBashCategories.map(String)
            : []
        }
      : undefined
  }
}

function formatToolCounts(counts: Map<string, number>): string {
  if (counts.size === 0) return "none"
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tool, count]) => `${tool}:${count}`)
    .join(",")
}

function fileSizeOrZero(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

function resetWorkspaceForRetry(workspaceDir: string, baseSha: string) {
  execFileSync("git", ["reset", "--hard", baseSha], {
    cwd: workspaceDir,
    stdio: "ignore"
  })
  execFileSync("git", ["clean", "-fdx"], {
    cwd: workspaceDir,
    stdio: "ignore"
  })

  const status = execFileSync("git", ["status", "--porcelain=v1", "-uall"], {
    cwd: workspaceDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"]
  })
  if (status.trim() !== "") {
    throw new Error("RETRY_WORKSPACE_RESET_FAILED")
  }
}

export class ModelExecutor {
  private selector: ModelSelector
  private runnerFactory?: (model: string) => { run: () => Promise<AgentRunResult> }
  private maxAttempts: number
  private privateDir: string
  private workspaceDir?: string
  private opencodeConfigPath?: string
  private opencodeConfigDir?: string
  private agentEnv: Record<string, string>
  private requiresChanges: boolean
  private baseSha?: string
  private completionResultPath?: string
  private requireCompletionResult: boolean
  private attemptTimeoutMs?: number

  constructor(options: ModelExecutorOptions = {}) {
    this.selector = options.selector || new ModelSelector()
    this.runnerFactory = options.runnerFactory
    this.maxAttempts = options.maxAttempts ?? 3
    this.privateDir = options.privateDir || process.env.RUNNER_TEMP || "./private-storage"
    this.workspaceDir = options.workspaceDir
    this.opencodeConfigPath = options.opencodeConfigPath
    this.opencodeConfigDir = options.opencodeConfigDir
    this.agentEnv = options.agentEnv || {}
    this.requiresChanges = options.requiresChanges === true
    this.baseSha = options.baseSha
    this.completionResultPath = options.completionResultPath
    this.requireCompletionResult = options.requireCompletionResult === true
    this.attemptTimeoutMs = options.attemptTimeoutMs
  }

  public async executeLane(
    laneId: string,
    role: string,
    prompt = "Execute the task contract. Run verification and call complete_lane when finished."
  ): Promise<ModelExecutionResult> {
    const attempts: ModelExecutionAttempt[] = []
    const attemptedModels: string[] = []
    let configPreflightPassed = false

    if (this.workspaceDir) {
      const workspaceStatus = new CapabilityRuntimeManager().captureWorkspaceStatus(this.workspaceDir)
      if (workspaceStatus !== "") {
        return {
          success: false,
          status: "FAIL",
          attempts,
          error: "CAPABILITY_WORKSPACE_POLLUTION"
        }
      }
    }

    for (let i = 0; i < this.maxAttempts; i++) {
      if (i > 0 && this.workspaceDir) {
        try {
          resetWorkspaceForRetry(this.workspaceDir, this.baseSha || "HEAD")
          console.log(`[ModelExecutor Retry] lane=${laneId} attempt=${i + 1} workspace=RESET_CLEAN`)
        } catch {
          return {
            success: false,
            status: "FAIL",
            attempts,
            error: "RETRY_WORKSPACE_RESET_FAILED"
          }
        }
      }

      const model = this.selector.getFallbackModel(role, attemptedModels)
      if (!model) {
        return {
          success: false,
          status: attempts[attempts.length - 1]?.status || "UNAVAILABLE",
          attempts,
          error: attempts[attempts.length - 1]?.errorCategory || "FREE_MODEL_UNAVAILABLE"
        }
      }

      attemptedModels.push(model)

      if (this.completionResultPath && fs.existsSync(this.completionResultPath)) {
        fs.rmSync(this.completionResultPath, { force: true })
      }

      const telemetryPath = path.join(this.privateDir, "telemetry.jsonl")
      const telemetryStartOffset = fileSizeOrZero(telemetryPath)

      let runner: { run: () => Promise<AgentRunResult> }
      if (this.runnerFactory) {
        runner = this.runnerFactory(model)
      } else {
        const attemptRuntimeRoot = path.join(
          this.privateDir,
          "opencode-attempts",
          `attempt-${i + 1}`
        )
        const attemptHomeDir = path.join(attemptRuntimeRoot, "home")
        fs.rmSync(attemptRuntimeRoot, { recursive: true, force: true })
        fs.mkdirSync(attemptHomeDir, { recursive: true })

        const attemptAgentEnv = {
          ...this.agentEnv,
          // OpenCode 1.18.x resolves its project root from PWD before process.cwd().
          // Keep PWD aligned with the trusted target checkout instead of inheriting
          // the worker-harness checkout from the GitHub Actions parent process.
          ...(this.workspaceDir ? { PWD: path.resolve(this.workspaceDir) } : {}),
          HOME: attemptHomeDir,
          XDG_CONFIG_HOME: path.join(attemptHomeDir, ".config"),
          XDG_DATA_HOME: path.join(attemptHomeDir, ".local", "share"),
          XDG_CACHE_HOME: path.join(attemptHomeDir, ".cache")
        }

        if (!model.startsWith("opencode/") || !model.includes("-free")) {
          return {
            success: false,
            status: "FAIL",
            actualModel: model,
            attempts,
            error: "MODEL_UNAVAILABLE"
          }
        }

        if (
          !configPreflightPassed &&
          this.opencodeConfigPath &&
          this.opencodeConfigDir &&
          this.workspaceDir
        ) {
          const preflight = new CapabilityRuntimeManager().preflightOpenCodeConfig({
            configPath: this.opencodeConfigPath,
            configDir: this.opencodeConfigDir,
            targetWorkspaceDir: this.workspaceDir,
            model
          })
          if (!preflight.ok) {
            console.log(
              "[ModelExecutor Preflight] lane=" + laneId + " status=FAIL category=" + preflight.category
            )
            return {
              success: false,
              status: "FAIL",
              actualModel: model,
              attempts,
              error: preflight.category
            }
          }
          configPreflightPassed = true
          console.log("[ModelExecutor Preflight] lane=" + laneId + " status=PASS")
        }
        const lanePrivateDir = path.join(this.privateDir, laneId)
        runner = new AgentRunner({
          laneId,
          privateDir: lanePrivateDir,
          command: OPENCODE_COMMAND,
          args: opencodeArgs(["run", "-m", model, "--auto", prompt]),
          cwd: this.workspaceDir,
          timeoutMs: this.attemptTimeoutMs,
          env:
            this.opencodeConfigPath && this.opencodeConfigDir
              ? {
                  ...attemptAgentEnv,
                  OPENCODE_CONFIG: this.opencodeConfigPath,
                  OPENCODE_CONFIG_DIR: this.opencodeConfigDir,
                  OTONOM_MODEL_USED: model
                }
              : {
                  ...attemptAgentEnv,
                  OTONOM_MODEL_USED: model
                }
        })
      }

      let runResult = await runner.run()

      if (
        runResult.status === "PASS" &&
        this.requiresChanges &&
        this.workspaceDir
      ) {
        const detector = new GitChangeDetector({
          workspaceRoot: this.workspaceDir,
          baseSha: this.baseSha || "HEAD"
        })
        const changes = detector.detectChanges().actualChangedPaths
        if (changes.length === 0) {
          runResult = {
            ...runResult,
            status: "FAIL",
            errorCategory: "NO_WORK_PRODUCT",
            sanitizedSummary: `[OTONOM-HARNESS] Lane '${laneId}' produced no required repository changes.`
          }
        }
      }

      if (runResult.status === "PASS" && this.requireCompletionResult) {
        let completionOk = false
        if (this.completionResultPath && fs.existsSync(this.completionResultPath)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(this.completionResultPath, "utf-8"))
            completionOk =
              parsed?.status === "PASS" &&
              parsed?.task_id === laneId &&
              parsed?.lane === laneId
          } catch {
            completionOk = false
          }
        }
        if (!completionOk) {
          runResult = {
            ...runResult,
            status: "FAIL",
            errorCategory: this.completionResultPath && fs.existsSync(this.completionResultPath)
              ? "COMPLETION_CONTRACT_FAILED"
              : "RESULT_MISSING",
            sanitizedSummary: `[OTONOM-HARNESS] Lane '${laneId}' did not produce a valid PASS completion result.`
          }
        }
      }

      const telemetry = readAttemptTelemetry(telemetryPath, telemetryStartOffset)
      const changedPathCount = this.workspaceDir
        ? new GitChangeDetector({
            workspaceRoot: this.workspaceDir,
            baseSha: this.baseSha || "HEAD"
          }).detectChanges().actualChangedPaths.length
        : 0
      const completionResultPresent =
        this.completionResultPath !== undefined && fs.existsSync(this.completionResultPath)
      const mutationAttempted =
        (telemetry.attempted.get("write") || 0) +
          (telemetry.attempted.get("edit") || 0) +
          (telemetry.attempted.get("patch") || 0) >
        0
      const mutationCompleted =
        (telemetry.completed.get("write") || 0) +
          (telemetry.completed.get("edit") || 0) +
          (telemetry.completed.get("patch") || 0) >
        0

      console.log(
        [
          "[ModelExecutor Diagnostic]",
          `lane=${laneId}`,
          `attempt=${i + 1}`,
          `events=${telemetry.events}`,
          `tools_attempted=${formatToolCounts(telemetry.attempted)}`,
          `tools_completed=${formatToolCounts(telemetry.completed)}`,
          `bash_attempted=${formatToolCounts(telemetry.attemptedBashCategories)}`,
          `mutation_attempted=${mutationAttempted}`,
          `mutation_completed=${mutationCompleted}`,
          `verification_completed=${(telemetry.completed.get("run_verification") || 0) > 0}`,
          `completion_completed=${(telemetry.completed.get("complete_lane") || 0) > 0}`,
          `session_errors=${telemetry.sessionErrors}`,
          `idle_pending_tools=${telemetry.idleState?.pendingToolCount ?? -1}`,
          `idle_pending_mutations=${telemetry.idleState?.pendingMutationCount ?? -1}`,
          `idle_pending_owned_mutations=${telemetry.idleState?.pendingOwnedMutationCount ?? -1}`,
          `idle_change_count=${telemetry.idleState?.workspaceChangeCount ?? -1}`,
          `idle_owned_change_count=${telemetry.idleState?.ownedChangeCount ?? -1}`,
          `idle_unowned_change_count=${telemetry.idleState?.unownedChangeCount ?? -1}`,
          `idle_pending_bash=${telemetry.idleState?.pendingBashCategories.join(",") || "none"}`,
          `change_trace=${telemetry.changeTrace.length > 0 ? telemetry.changeTrace.join(">") : "none"}`,
          `result_present=${completionResultPresent}`,
          `changed_path_count=${changedPathCount}`,
          `stdout_bytes=${fileSizeOrZero(runResult.stdoutPath)}`,
          `stderr_bytes=${fileSizeOrZero(runResult.stderrPath)}`
        ].join(" ")
      )

      this.selector.recordAttempt(laneId, role, model, runResult.status)
      attempts.push({
        model,
        status: runResult.status,
        durationMs: runResult.durationMs,
        errorCategory: runResult.errorCategory
      })
      console.log(`[ModelExecutor] lane=${laneId} model=${model} status=${runResult.status} category=${runResult.errorCategory || "NONE"} duration_ms=${runResult.durationMs}`)

      if (runResult.status === "PASS") {
        return {
          success: true,
          status: "PASS",
          actualModel: model,
          attempts,
          lastResult: runResult
        }
      }

      let genericNonZeroWithoutWork = false
      if (
        runResult.status === "FAIL" &&
        runResult.errorCategory === "NON_ZERO_EXIT"
      ) {
        if (this.workspaceDir) {
          const detector = new GitChangeDetector({
            workspaceRoot: this.workspaceDir,
            baseSha: this.baseSha || "HEAD"
          })
          genericNonZeroWithoutWork = detector.detectChanges().actualChangedPaths.length === 0
        } else {
          genericNonZeroWithoutWork = true
        }
      }

      const isTransientOrInfrastructure =
        runResult.status === "RATE_LIMITED" ||
        runResult.status === "STALLED" ||
        runResult.status === "UNAVAILABLE" ||
        runResult.errorCategory === "PROCESS_ERROR" ||
        runResult.errorCategory === "MODEL_UNAVAILABLE" ||
        runResult.errorCategory === "NO_WORK_PRODUCT" ||
        runResult.errorCategory === "RESULT_MISSING" ||
        runResult.errorCategory === "COMPLETION_CONTRACT_FAILED" ||
        genericNonZeroWithoutWork

      if (isTransientOrInfrastructure && i + 1 < this.maxAttempts) {
        continue
      }

      if (runResult.status === "FAIL") {
        return {
          success: false,
          status: "FAIL",
          actualModel: model,
          attempts,
          lastResult: runResult,
          error: runResult.errorCategory || "Deterministic execution failure"
        }
      }
    }

    return {
      success: false,
      status: attempts[attempts.length - 1]?.status || "FAIL",
      actualModel: attemptedModels[attemptedModels.length - 1],
      attempts,
      error: attempts[attempts.length - 1]?.errorCategory || `Maximum model attempts (${this.maxAttempts}) exhausted`
    }
  }
}
