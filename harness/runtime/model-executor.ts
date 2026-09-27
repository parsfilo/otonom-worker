import { ModelSelector } from "./model-selector.js"
import { AgentRunner, AgentRunResult, AgentExecutionStatus } from "./agent-runner.js"
import path from "node:path"

export interface ModelExecutorOptions {
  selector?: ModelSelector
  runnerFactory?: (model: string) => { run: () => Promise<AgentRunResult> }
  maxAttempts?: number
  privateDir?: string
  workspaceDir?: string
}

export interface ModelExecutionAttempt {
  model: string
  status: AgentExecutionStatus
  durationMs: number
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

  constructor(options: ModelExecutorOptions = {}) {
    this.selector = options.selector || new ModelSelector()
    this.runnerFactory = options.runnerFactory
    this.maxAttempts = options.maxAttempts ?? 3
    this.privateDir = options.privateDir || process.env.RUNNER_TEMP || "./private-storage"
    this.workspaceDir = options.workspaceDir
  }

  public async executeLane(
    laneId: string,
    role: string,
    prompt = "Execute the task contract in task.json. Run verification and call complete_lane when finished."
  ): Promise<ModelExecutionResult> {
    const attempts: ModelExecutionAttempt[] = []
    const attemptedModels: string[] = []

    for (let i = 0; i < this.maxAttempts; i++) {
      const model = this.selector.getFallbackModel(role, attemptedModels)
      if (!model) {
        return {
          success: false,
          status: attempts[attempts.length - 1]?.status || "UNAVAILABLE",
          attempts,
          error: "All permitted fallback models exhausted"
        }
      }

      attemptedModels.push(model)

      // Create runner (custom factory in tests or real AgentRunner)
      let runner: { run: () => Promise<AgentRunResult> }
      if (this.runnerFactory) {
        runner = this.runnerFactory(model)
      } else {
        const lanePrivateDir = path.join(this.privateDir, laneId)
        runner = new AgentRunner({
          laneId,
          privateDir: lanePrivateDir,
          command: "opencode",
          args: ["run", "-m", model, "--auto", prompt],
          cwd: this.workspaceDir
        })
      }

      const runResult = await runner.run()

      this.selector.recordAttempt(laneId, role, model, runResult.status)
      attempts.push({
        model,
        status: runResult.status,
        durationMs: runResult.durationMs
      })

      // 1. Success on current model
      if (runResult.status === "PASS") {
        return {
          success: true,
          status: "PASS",
          actualModel: model,
          attempts,
          lastResult: runResult
        }
      }

      // 2. Deterministic code / verification failure: do NOT retry across models forever
      if (runResult.status === "FAIL") {
        return {
          success: false,
          status: "FAIL",
          actualModel: model,
          attempts,
          lastResult: runResult,
          error: "Deterministic execution failure"
        }
      }

      // 3. Transient failure (RATE_LIMITED, STALLED, UNAVAILABLE): continue loop to next model
    }

    return {
      success: false,
      status: attempts[attempts.length - 1]?.status || "FAIL",
      actualModel: attemptedModels[attemptedModels.length - 1],
      attempts,
      error: `Maximum model attempts (${this.maxAttempts}) exhausted`
    }
  }
}
