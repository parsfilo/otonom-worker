import fs from "node:fs"
import path from "node:path"
import { tool, type Plugin } from "@opencode-ai/plugin"
import { sanitizeEnv } from "../../harness/policies/env-policy.js"
import { evaluateCommandPolicy } from "../../harness/policies/command-policy.js"
import { OwnershipTracker } from "../../harness/policies/ownership.js"
import { LoopDetector, LoopStatus } from "../../harness/policies/loop-detector.js"
import { HarnessLogger } from "../../harness/logging/logger.js"
import { GitChangeDetector } from "../../harness/finalizer/git-detector.js"
import type { VerificationResult } from "../../harness/verification/runner.js"
import { TaskContextTool } from "../tools/task-context.js"
import { RecordFindingTool } from "../tools/record-finding.js"
import { CrossLaneRequestTool } from "../tools/cross-lane-request.js"
import { RunVerificationTool } from "../tools/run-verification.js"
import { CompleteLaneTool } from "../tools/complete-lane.js"

export interface OtonomPluginContext {
  taskPath?: string
  resultPath?: string
  privateDir?: string
  workspaceRoot?: string
  lane?: string
  runnerTemp?: string
}


function isDependencyMutationCommand(command: string): boolean {
  return /(?:^|[;&|\n]\s*)(?:pnpm\s+(?:i|install|add|remove|rm|update|up|import)|npm\s+(?:i|install|uninstall|remove|update)|yarn\s+(?:install|add|remove|up|upgrade)|bun\s+(?:install|add|remove|update))\b/i.test(command)
}

const DEPENDENCY_CONTROL_PATHS = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb"
]


const READ_ONLY_ROLES = new Set([
  "reviewer-cross-system",
  "security-reviewer",
  "ci-reviewer",
  "integration-reviewer",
  "final-auditor"
])

const BLOCKED_TOOLS = new Set(["task", "agent", "webfetch", "websearch"])

function isOutsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  const resolved = path.resolve(workspaceRoot, candidate)
  const relative = path.relative(workspaceRoot, resolved)
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}

function asToolOutput(value: unknown): string {
  return JSON.stringify(value)
}

function classifyBashCommand(command: string): string {
  const normalized = command.trim().toLowerCase()
  if (/\bgit\s+status\b/.test(normalized)) return "git_status"
  if (/\bgit\s+diff\b/.test(normalized)) return "git_diff"
  if (/\bgit\s+clean\b/.test(normalized)) return "git_clean"
  if (/\bgit\s+reset\b/.test(normalized)) return "git_reset"
  if (/\bgit\s+(?:checkout|restore)\b/.test(normalized)) return "git_restore"
  if (/\brm\b/.test(normalized)) return "remove"
  if (/\bmkdir\b/.test(normalized)) return "mkdir"
  if (/\b(?:test|vitest|jest|lint|typecheck|tsc)\b/.test(normalized)) return "verification"
  return "other"
}

export function createOtonomPlugin(options: OtonomPluginContext = {}): any {
  const workspaceRoot = path.resolve(options.workspaceRoot || process.cwd())
  const taskPath = path.resolve(
    options.taskPath || process.env.TASK_PATH || path.join(workspaceRoot, "task.json")
  )
  const resultPath = path.resolve(
    options.resultPath || process.env.RESULT_PATH || path.join(path.dirname(taskPath), "result.json")
  )

  let task: any = null
  let lane = options.lane || process.env.LANE_ID || "default-lane"

  if (fs.existsSync(taskPath)) {
    try {
      task = JSON.parse(fs.readFileSync(taskPath, "utf-8"))
      lane = task.id || lane
    } catch {
      // Task loading error is surfaced by task_context / completion.
    }
  }

  const logger = new HarnessLogger({
    lane,
    runnerTemp: options.runnerTemp
  })
  const privateDir = path.resolve(
    options.privateDir || process.env.PRIVATE_DIR || logger.getPrivateLogDir()
  )
  fs.mkdirSync(privateDir, { recursive: true })

  const ownershipTracker = new OwnershipTracker({
    allowedWritePaths: task ? task.allowed_write_paths : [],
    forbiddenWritePaths: task ? task.forbidden_write_paths || [] : []
  })
  const loopDetector = new LoopDetector()
  const taskContextTool = new TaskContextTool(taskPath)
  const recordFindingTool = new RecordFindingTool(privateDir)
  const crossLaneRequestTool = new CrossLaneRequestTool(privateDir, lane)
  const runVerificationTool = new RunVerificationTool({ cwd: workspaceRoot })
  let latestVerification: VerificationResult | undefined

  const hooks = {
    "shell.env": async (_input: any, output: { env: Record<string, string> }) => {
      output.env = sanitizeEnv(output.env || process.env)
    },

    "tool.execute.before": async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { args: any }
    ) => {
      // Safe diagnostic metadata only: never record args, source, prompts or tool output.
      logger.logPrivateTelemetry({
        phase: "before",
        tool: input.tool,
        ...(input.tool === "bash"
          ? { commandCategory: classifyBashCommand(output.args?.command || "") }
          : {})
      })

      if (BLOCKED_TOOLS.has(input.tool)) {
        throw new Error(`Tool blocked by harness security policy: ${input.tool}`)
      }

      if (input.tool === "read") {
        const rawReadPath = output.args?.filePath || output.args?.path || ""
        if (rawReadPath) {
          const normalized = rawReadPath.replace(/\\/g, "/")
          if (isOutsideWorkspace(workspaceRoot, rawReadPath) || /(?:^|\/)\.env(?:\.|$)/i.test(normalized)) {
            throw new Error("Read blocked by harness workspace boundary")
          }
        }
      }

      const loopState = loopDetector.recordToolCall(input.tool, output.args)
      if (loopState === LoopStatus.WARNING) {
        logger.logPrivateDiagnostic(`[LoopDetector] Stall warning on repeated tool: ${input.tool}`)
      } else if (loopState === LoopStatus.STALLED) {
        logger.logPrivateDiagnostic(`[LoopDetector] STALLED condition reached on tool: ${input.tool}`)
        throw new Error("Loop detected: identical tool call repeated excessively. Session stalled.")
      }

      if (input.tool === "bash") {
        const command = output.args?.command || ""
        const evalResult = evaluateCommandPolicy(command)
        if (!evalResult.allowed) {
          logger.logPrivateDiagnostic(`[CommandPolicy] BLOCKED: ${command} (${evalResult.reason})`)
          throw new Error(`Command blocked by harness security policy: ${evalResult.reason}`)
        }
        if (task && isDependencyMutationCommand(command)) {
          const dependencyWriteOwned = DEPENDENCY_CONTROL_PATHS.some((candidate) =>
            ownershipTracker.checkPath(candidate).allowed
          )
          if (!dependencyWriteOwned) {
            logger.logPrivateDiagnostic(`[CommandPolicy] BLOCKED dependency mutation outside task ownership`)
            throw new Error("Dependency mutation blocked: package manifests/lockfiles are outside this task's owned paths.")
          }
        }
      }

      if (["edit", "write", "patch"].includes(input.tool)) {
        if (task && READ_ONLY_ROLES.has(task.role)) {
          throw new Error(`Mutation blocked: role '${task.role}' is read-only.`)
        }
        const rawTargetPath = output.args?.filePath || output.args?.path || ""
        if (rawTargetPath) {
          const relativePath = path.isAbsolute(rawTargetPath)
            ? path.relative(workspaceRoot, rawTargetPath)
            : rawTargetPath
          const check = ownershipTracker.recordEdit(relativePath)
          if (!check.allowed) {
            logger.logPrivateDiagnostic(`[OwnershipPolicy] BLOCKED EDIT: ${relativePath}`)
            throw new Error(`Edit forbidden by task ownership: ${check.violation?.detail}`)
          }
        }
      }
    },

    "tool.execute.after": async (
      input: { tool: string; sessionID?: string; callID?: string; args: any },
      output: { title?: string; output?: string; metadata?: any }
    ) => {
      const outStr = typeof output.output === "string" ? output.output : JSON.stringify(output.output || "")
      const observesWorkspaceState = ["bash", "write", "edit", "patch"].includes(input.tool)
      const workspaceChangeCount =
        observesWorkspaceState && task
          ? new GitChangeDetector({
              workspaceRoot,
              baseSha: task.base_sha
            }).detectChanges().actualChangedPaths.length
          : undefined

      logger.logPrivateTelemetry({
        phase: "after",
        tool: input.tool,
        ...(input.tool === "bash"
          ? { commandCategory: classifyBashCommand(input.args?.command || "") }
          : {}),
        ...(workspaceChangeCount === undefined ? {} : { workspaceChangeCount }),
        outputLength: outStr.length,
        truncated: outStr.length > 2000,
        loopMetrics: loopDetector.getMetrics(),
        ownershipViolationsCount: ownershipTracker.getViolations().length
      })
    },

    "experimental.session.compacting": async (
      _input: { sessionID: string },
      output: { context: string[]; prompt?: string }
    ) => {
      if (!task) return

      output.context.push(`
### COMPACTED SWARM TASK ANCHOR
- TASK_ID: ${task.id}
- ROLE: ${task.role}
- BASE_SHA: ${task.base_sha}
- ALLOWED_WRITE_PATHS: ${task.allowed_write_paths.join(", ")}
- OBJECTIVES:
${task.objectives.map((o: string) => `  * ${o}`).join("\n")}
- ACCEPTANCE_CRITERIA:
${task.acceptance_criteria.map((c: string) => `  * ${c}`).join("\n")}
- VERIFICATION_PROFILE: ${task.verification_profile}
- REQUIRES_CHANGES: ${task.requires_changes === true ? "true" : "false"}
- OWNERSHIP_STATUS: ${ownershipTracker.hasViolations() ? "VIOLATION_PRESENT" : "CLEAN"}
- NOTE: Free model execution must follow the task contract. No remote push. Run run_verification and complete_lane when finished.
      `)
    },

    event: async ({ event }: { event: any }) => {
      if (event.type === "file.edited" && event.path) {
        const relativePath = path.isAbsolute(event.path)
          ? path.relative(workspaceRoot, event.path)
          : event.path
        ownershipTracker.recordEdit(relativePath)
        loopDetector.recordProgress()
      }
      if (event.type === "session.idle") {
        logger.logPrivateDiagnostic("[Session] Received session.idle event")
        logger.logPrivateTelemetry({ phase: "event", event: "session.idle" })
      }
      if (event.type === "session.error") {
        const errorName = event.error?.name || "unspecified"
        logger.logPrivateDiagnostic(`[Session Error] Error event received: ${errorName}`)
        logger.logPrivateTelemetry({ phase: "event", event: "session.error", errorName })
      }
    }
  }

  const toolDefinitions = {
    task_context: tool({
      description: "Read the current OTONOM lane task contract from trusted control storage.",
      args: {},
      async execute() {
        return asToolOutput(await taskContextTool.execute())
      }
    }),

    run_verification: tool({
      description: "Run one named trusted verification profile in the target workspace.",
      args: {
        profile: tool.schema.string().describe("Verification profile from the task contract")
      },
      async execute(args) {
        latestVerification = await runVerificationTool.execute({ profile: args.profile })
        return asToolOutput(latestVerification)
      }
    }),

    complete_lane: tool({
      description: "Complete the lane only after verification and ownership checks pass, writing result.json to trusted control storage.",
      args: {},
      async execute() {
        if (!task) {
          return asToolOutput({ completed: false, error: "TASK_CONTEXT_MISSING" })
        }
        const changedPaths = new GitChangeDetector({
          workspaceRoot,
          baseSha: task.base_sha
        }).detectChanges().actualChangedPaths
        const completeLaneTool = new CompleteLaneTool({
          taskPath,
          resultPath,
          privateDir,
          workspaceRoot,
          latestVerification,
          ownershipViolations: ownershipTracker.getViolations(),
          changedPaths,
          modelUsed: process.env.OTONOM_MODEL_USED || "opencode-runtime",
          loopMetrics: loopDetector.getMetrics()
        })
        return asToolOutput(await completeLaneTool.execute())
      }
    }),

    record_finding: tool({
      description: "Record a bounded structured finding in private runner storage.",
      args: {
        id: tool.schema.string(),
        severity: tool.schema.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]),
        path: tool.schema.string(),
        summary: tool.schema.string(),
        evidence: tool.schema.string(),
        rule_id: tool.schema.string().optional(),
        status: tool.schema.enum(["open", "fixed", "suppressed", "wontfix"])
      },
      async execute(args) {
        return asToolOutput(await recordFindingTool.execute(args))
      }
    }),

    cross_lane_request: tool({
      description: "Record a structured request for work owned by another lane.",
      args: {
        id: tool.schema.string(),
        target_lane: tool.schema.string(),
        requested_path: tool.schema.string(),
        justification: tool.schema.string(),
        proposed_change_description: tool.schema.string()
      },
      async execute(args) {
        return asToolOutput(await crossLaneRequestTool.execute(args))
      }
    })
  }

  return {
    name: "otonom-harness",
    hooks,
    tool: toolDefinitions,
    tools: {
      task_context: taskContextTool,
      record_finding: recordFindingTool,
      cross_lane_request: crossLaneRequestTool,
      run_verification: runVerificationTool
    },
    ownershipTracker,
    loopDetector,
    logger,
    taskPath,
    resultPath
  }
}

export const OtonomPlugin: Plugin = async (ctx) => {
  const pluginInstance = createOtonomPlugin({
    taskPath: process.env.TASK_PATH,
    resultPath: process.env.RESULT_PATH,
    privateDir: process.env.PRIVATE_DIR,
    workspaceRoot: ctx?.directory || process.cwd(),
    lane: process.env.LANE_ID
  })

  return {
    ...pluginInstance.hooks,
    tool: pluginInstance.tool
  }
}

export default OtonomPlugin
