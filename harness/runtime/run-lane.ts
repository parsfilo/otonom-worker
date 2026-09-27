import fs from "node:fs"
import path from "node:path"
import { ModelExecutor } from "./model-executor.js"

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

  console.log(`[Run Lane] Starting OpenCode execution for lane: '${laneId}' (role: ${role})`)
  fs.mkdirSync(privateDir, { recursive: true })
  fs.mkdirSync(controlDir, { recursive: true })

  const executor = new ModelExecutor({
    privateDir,
    workspaceDir: targetWorkspaceDir,
    maxAttempts: 3
  })

  const execResult = await executor.executeLane(laneId, role)

  // Ensure result.json exists in controlDir for the finalizer
  const resultPath = path.join(controlDir, "result.json")
  if (!fs.existsSync(resultPath)) {
    // If agent process exited without writing result.json, synthesize a valid failure result record
    const syntheticResult = {
      task_id: laneId,
      lane: laneId,
      base_sha: task.base_sha,
      status: execResult.status === "PASS" ? "FAIL" : execResult.status,
      model_used: execResult.actualModel || "none",
      changed_paths: [],
      verification_results: [],
      test_summary: { total: 0, passed: 0, failed: 1, skipped: 0 },
      policy_violations: [],
      findings_fixed: [],
      remaining_blockers: [execResult.error || "Agent terminated without result manifest"],
      cross_lane_request_count: 0,
      loop_metrics: {
        tool_repeats: 0,
        file_rereads: 0,
        stall_warnings: 0,
        diff_hash_changes: 0
      },
      completed_at: new Date().toISOString()
    }
    fs.writeFileSync(resultPath, JSON.stringify(syntheticResult, null, 2))
  }

  console.log(`[Run Lane] Execution completed with status: ${execResult.status}`)
  if (execResult.status !== "PASS") {
    console.log(`[Run Lane Note] Agent status is non-passing (${execResult.status}). Proceeding to finalizer for evidence reconciliation.`)
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
