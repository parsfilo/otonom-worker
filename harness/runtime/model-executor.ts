import { ModelSelector } from "./model-selector.js"
import { AgentRunner, AgentRunResult, AgentExecutionStatus } from "./agent-runner.js"
import { CapabilityRuntimeManager, OPENCODE_COMMAND, opencodeArgs } from "./capability-runtime.js"
import { GitChangeDetector } from "../finalizer/git-detector.js"
import path from "node:path"

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
  }

  public async executeLane(
    laneId: string,
    role: string,
    prompt = "Execute the task contract. Run verification and call complete_lane when finished."
  ): Promise<ModelExecutionResult> {
    const attempts: ModelExecutionAttempt[] = []
    const attemptedModels: string[] = []

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

      let runner: { run: () => Promise<AgentRunResult> }
      if (this.runnerFactory) {
        runner = this.runnerFactory(model)
      } else {
        if (this.opencodeConfigPath && this.opencodeConfigDir && this.workspaceDir) {
          const preflight = new CapabilityRuntimeManager().preflightOpenCodeConfig({
            configPath: this.opencodeConfigPath,
            configDir: this.opencodeConfigDir,
            targetWorkspaceDir: this.workspaceDir,
            model
          })
          if (!preflight.ok) {
            return {
              success: false,
              status: "FAIL",
              actualModel: model,
              attempts,
              error: preflight.category
            }
          }
        }
        const lanePrivateDir = path.join(this.privateDir, laneId)
        runner = new AgentRunner({
          laneId,
          privateDir: lanePrivateDir,
          command: OPENCODE_COMMAND,
          args: opencodeArgs(["run", "-m", model, "--auto", prompt]),
          cwd: this.workspaceDir,
          env:
            this.opencodeConfigPath && this.opencodeConfigDir
              ? {
                  ...this.agentEnv,
                  OPENCODE_CONFIG: this.opencodeConfigPath,
                  OPENCODE_CONFIG_DIR: this.opencodeConfigDir,
                  OTONOM_MODEL_USED: model
                }
              : {
                  ...this.agentEnv,
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

      this.selector.recordAttempt(laneId, role, model, runResult.status)
      attempts.push({
        model,
        status: runResult.status,
        durationMs: runResult.durationMs,
        errorCategory: runResult.errorCategory
      })

      if (runResult.status === "PASS") {
        return {
          success: true,
          status: "PASS",
          actualModel: model,
          attempts,
          lastResult: runResult
        }
      }

      const isTransientOrInfrastructure =
        runResult.status === "RATE_LIMITED" ||
        runResult.status === "STALLED" ||
        runResult.status === "UNAVAILABLE" ||
        runResult.errorCategory === "PROCESS_ERROR" ||
        runResult.errorCategory === "MODEL_UNAVAILABLE" ||
        runResult.errorCategory === "NO_WORK_PRODUCT"

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
