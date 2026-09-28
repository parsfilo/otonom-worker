import fs from "node:fs"
import path from "node:path"
import { ModelExecutor } from "./model-executor.js"
import { ModelSelector } from "./model-selector.js"
import { GitChangeDetector } from "../finalizer/git-detector.js"


export function buildTaskPrompt(task: any): string {
  return [
    `Task ID: ${task.id}`,
    `Objectives:`,
    ...task.objectives.map((o: string) => `- ${o}`),
    `Acceptance Criteria:`,
    ...task.acceptance_criteria.map((c: string) => `- ${c}`),
    `Required Verification Profile:`,
    `- ${task.verification_profile}`,
    `Allowed Write Paths (Strict Ownership):`,
    ...task.allowed_write_paths.map((p: string) => `- ${p}`),
    `Instructions:`,
    `- Modify ONLY files listed under Allowed Write Paths. Any other file edit will fail the lane.`,
    `- Fulfill all task objectives directly; a textual explanation without the required repository changes is NOT completion.`,
    `- Before finishing, confirm the required work product exists, run the required verification profile, and call complete_lane.`,
    `- Do not run dependency-mutating package-manager commands (install/add/remove/update) unless package manifests/lockfiles are explicitly inside Allowed Write Paths.`,
    `- Do not attempt git push, gh PR commands, or network credential access.`
  ].join("\n")
}

export async function runLane(
  taskPath: string,
  controlDir: string,
  privateDir: string,
  targetWorkspaceDir: string
) {
  if (!fs.existsSync(taskPath)) {
    throw new Error(`Task file not found: ${taskPath}`)
  }

  const task = JSON.parse(fs.readFileSync(taskPath, "utf-8"))
  const laneId = task.id
  const role = task.role
  const resultPath = path.join(controlDir, "result.json")

  console.log(`[Run Lane] Starting OpenCode execution for lane: '${laneId}' (role: ${role})`)
  fs.mkdirSync(privateDir, { recursive: true })
  fs.mkdirSync(controlDir, { recursive: true })

  fs.writeFileSync(
    path.join(privateDir, "sentinel.log"),
    "PRIVATE_LOG_SENTINEL_PHASE2\n"
  )

  const prompt = buildTaskPrompt(task)

  const selector = new ModelSelector({ autoDiscover: true })
  const opencodeConfigDir = path.join(controlDir, "opencode")
  const executor = new ModelExecutor({
    selector,
    privateDir,
    workspaceDir: targetWorkspaceDir,
    opencodeConfigPath: path.join(opencodeConfigDir, "opencode.json"),
    opencodeConfigDir,
    maxAttempts: 3,
    requiresChanges: task.requires_changes === true,
    baseSha: task.base_sha,
    completionResultPath: resultPath,
    requireCompletionResult: true,
    agentEnv: {
      TASK_PATH: taskPath,
      RESULT_PATH: resultPath,
      CONTROL_DIR: controlDir,
      PRIVATE_DIR: privateDir,
      LANE_ID: laneId
    }
  })

  const execResult = await executor.executeLane(laneId, role, prompt)

  if (!fs.existsSync(resultPath)) {
    const gitDetector = new GitChangeDetector({
      workspaceRoot: targetWorkspaceDir,
      baseSha: task.base_sha || "HEAD"
    })
    const changeSummary = gitDetector.detectChanges()
    const requiredWorkMissing = task.requires_changes === true && changeSummary.actualChangedPaths.length === 0
    const isPassing = false

    const syntheticResult = {
      task_id: laneId,
      lane: laneId,
      base_sha: task.base_sha,
      status: isPassing ? "PASS" : "FAIL",
      model_used: execResult.actualModel || "none",
      changed_paths: changeSummary.actualChangedPaths,
      verification_results: [],
      test_summary: {
        total: 0,
        passed: 0,
        failed: isPassing ? 0 : 1,
        skipped: 0
      },
      policy_violations: [],
      findings_fixed: [],
      remaining_blockers: [execResult.status !== "PASS"
        ? (execResult.error || execResult.status)
        : (requiredWorkMissing ? "NO_WORK_PRODUCT" : "RESULT_MISSING")],
      cross_lane_request_count: 0,
      loop_metrics: {
        tool_repeats: 0,
        file_rereads: 0,
        stall_warnings: 0,
        diff_hash_changes: changeSummary.actualChangedPaths.length
      },
      completed_at: new Date().toISOString()
    }
    fs.writeFileSync(resultPath, JSON.stringify(syntheticResult, null, 2))
  }

  console.log(`[Run Lane] Execution completed with status: ${execResult.status}`)
  if (execResult.status !== "PASS") {
    console.log(`[Run Lane Note] Agent status is non-passing (${execResult.error || execResult.status}). Proceeding to finalizer for evidence reconciliation.`)
  }
}

if (process.argv[1] && process.argv[1].endsWith("run-lane.ts")) {
  const taskPath = process.argv[2] || process.env.TASK_PATH || "task.json"
  const controlDir = process.argv[3] || process.env.CONTROL_DIR || "."
  const privateDir = process.argv[4] || process.env.PRIVATE_DIR || "./private"
  const targetWorkspace = process.argv[5] || process.env.TARGET_WORKSPACE || "."

  runLane(taskPath, controlDir, privateDir, targetWorkspace).catch((err) => {
    console.error(`[Run Lane Fatal] ${err.message}`)
    process.exit(1)
  })
}
