import fs from "node:fs"
import path from "node:path"
import { sanitizeEnv } from "../../harness/policies/env-policy.js"
import { evaluateCommandPolicy } from "../../harness/policies/command-policy.js"
import { OwnershipTracker } from "../../harness/policies/ownership.js"
import { LoopDetector, LoopStatus } from "../../harness/policies/loop-detector.js"
import { HarnessLogger } from "../../harness/logging/logger.js"
import { TaskContextTool } from "../tools/task-context.js"
import { RecordFindingTool } from "../tools/record-finding.js"
import { CrossLaneRequestTool } from "../tools/cross-lane-request.js"
import { RunVerificationTool } from "../tools/run-verification.js"
import { CompleteLaneTool } from "../tools/complete-lane.js"

export interface OtonomPluginContext {
  taskPath?: string
  workspaceRoot?: string
  lane?: string
  runnerTemp?: string
}

export function createOtonomPlugin(options: OtonomPluginContext = {}) {
  const workspaceRoot = options.workspaceRoot || process.cwd()
  const taskPath = options.taskPath || process.env.TASK_PATH || path.join(workspaceRoot, "task.json")

  let task: any = null
  let lane = options.lane || process.env.LANE_ID || "default-lane"

  if (fs.existsSync(taskPath)) {
    try {
      task = JSON.parse(fs.readFileSync(taskPath, "utf-8"))
      lane = task.id || lane
    } catch {
      // Task loading error handled in initialization
    }
  }

  const logger = new HarnessLogger({
    lane,
    runnerTemp: options.runnerTemp
  })

  const ownershipTracker = new OwnershipTracker({
    allowedWritePaths: task ? task.allowed_write_paths : ["**"],
    forbiddenWritePaths: task ? task.forbidden_write_paths || [] : []
  })

  const loopDetector = new LoopDetector()

  // Tool instances
  const taskContextTool = new TaskContextTool(taskPath)
  const recordFindingTool = new RecordFindingTool(logger.getPrivateLogDir())
  const crossLaneRequestTool = new CrossLaneRequestTool(logger.getPrivateLogDir(), lane)
  const runVerificationTool = new RunVerificationTool({ cwd: workspaceRoot })
  const completeLaneTool = new CompleteLaneTool({
    taskPath,
    privateDir: logger.getPrivateLogDir(),
    workspaceRoot
  })

  return {
    name: "otonom-harness",
    hooks: {
      /**
       * HOOK: shell.env
       * Strips credentials, injects safe CI variables
       */
      "shell.env": async (_input: any, output: { env: Record<string, string> }) => {
        output.env = sanitizeEnv(output.env || process.env)
      },

      /**
       * HOOK: tool.execute.before
       * Enforces command policy, ownership on edit, and loop detection
       */
      "tool.execute.before": async (
        input: { tool: string; sessionID?: string; callID?: string },
        output: { args: any }
      ) => {
        // 1. Loop detection
        const loopState = loopDetector.recordToolCall(input.tool, output.args)
        if (loopState === LoopStatus.WARNING) {
          logger.logPrivateDiagnostic(`[LoopDetector] Stall warning on repeated tool: ${input.tool}`)
        } else if (loopState === LoopStatus.STALLED) {
          logger.logPrivateDiagnostic(`[LoopDetector] STALLED condition reached on tool: ${input.tool}`)
          throw new Error("Loop detected: identical tool call repeated excessively. Session stalled.")
        }

        // 2. Command Policy for bash
        if (input.tool === "bash") {
          const command = output.args?.command || ""
          const evalResult = evaluateCommandPolicy(command)
          if (!evalResult.allowed) {
            logger.logPrivateDiagnostic(`[CommandPolicy] BLOCKED: ${command} (${evalResult.reason})`)
            throw new Error(`Command blocked by harness security policy: ${evalResult.reason}`)
          }
        }

        // 3. Ownership Policy on file write/edit
        if (["edit", "write", "patch"].includes(input.tool)) {
          const targetPath = output.args?.filePath || output.args?.path || ""
          if (targetPath) {
            const check = ownershipTracker.recordEdit(targetPath)
            if (!check.allowed) {
              logger.logPrivateDiagnostic(`[OwnershipPolicy] BLOCKED EDIT: ${targetPath}`)
              throw new Error(`Edit forbidden by task ownership: ${check.violation?.detail}`)
            }
          }
        }
      },

      /**
       * HOOK: tool.execute.after
       * Records private structured telemetry
       */
      "tool.execute.after": async (
        input: { tool: string; sessionID?: string; callID?: string; args: any },
        output: { title?: string; output?: string; metadata?: any }
      ) => {
        const outStr = typeof output.output === "string" ? output.output : JSON.stringify(output.output || "")
        logger.logPrivateTelemetry({
          tool: input.tool,
          outputLength: outStr.length,
          truncated: outStr.length > 2000,
          loopMetrics: loopDetector.getMetrics(),
          ownershipViolationsCount: ownershipTracker.getViolations().length
        })
      },

      /**
       * HOOK: experimental.session.compacting
       * Preserves critical task state across session compaction
       */
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
- OWNERSHIP_STATUS: ${ownershipTracker.hasViolations() ? "VIOLATION_PRESENT" : "CLEAN"}
- NOTE: Free model execution must follow task contract. No remote push. Run run_verification and complete_lane when finished.
        `)
      },

      /**
       * Event handlers: session.idle, session.error, file.edited
       */
      event: async ({ event }: { event: any }) => {
        if (event.type === "file.edited") {
          if (event.path) {
            ownershipTracker.recordEdit(event.path)
            loopDetector.recordProgress()
          }
        }

        if (event.type === "session.idle") {
          logger.logPrivateDiagnostic("[Session] Received session.idle event")
        }

        if (event.type === "session.error") {
          logger.logPrivateDiagnostic(`[Session Error] Error event received: ${event.error?.name || "unspecified"}`)
        }
      }
    },
    tools: {
      task_context: taskContextTool,
      record_finding: recordFindingTool,
      cross_lane_request: crossLaneRequestTool,
      run_verification: runVerificationTool,
      complete_lane: completeLaneTool
    },
    ownershipTracker,
    loopDetector,
    logger
  }
}

// Default export conforming to OpenCode plugin factory signature
export default async function OtonomPlugin(ctx: any) {
  const pluginInstance = createOtonomPlugin({
    workspaceRoot: ctx?.directory || process.cwd()
  })

  return pluginInstance.hooks
}
