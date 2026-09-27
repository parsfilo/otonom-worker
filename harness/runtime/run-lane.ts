import fs from "node:fs"
import path from "node:path"
import { ModelExecutor } from "./model-executor.js"
import { CapabilityRuntimeManager, SerenaRuntimeSupervisor } from "./capability-runtime.js"
import { GitChangeDetector } from "../finalizer/git-detector.js"

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

  // 1. Write private confidentiality sentinel into private runner storage ONLY
  fs.writeFileSync(
    path.join(privateDir, "sentinel.log"),
    "PRIVATE_LOG_SENTINEL_PHASE2\n"
  )

  // 2. Supervise Serena if role capability profile requires it
  const capabilityManager = new CapabilityRuntimeManager()
  const profile = capabilityManager.getProfile(role)
  let serenaSupervisor: SerenaRuntimeSupervisor | undefined

  if (profile.serena) {
    serenaSupervisor = new SerenaRuntimeSupervisor({
      workspaceDir: targetWorkspaceDir,
      targetSha: task.base_sha || "HEAD"
    })
    try {
      await serenaSupervisor.start()
    } catch (serenaErr: any) {
      console.error(`[Run Lane Warning] Serena runtime failed to start: ${serenaErr.message}`)
    }
  }

  // 3. Construct specific bounded task prompt without credentials
  const promptLines = [
    `Task ID: ${laneId}`,
    `Objectives:`,
    ...task.objectives.map((o: string) => `- ${o}`),
    `Allowed Write Paths (Strict Ownership):`,
    ...task.allowed_write_paths.map((p: string) => `- ${p}`),
    `Instructions:`,
    `- Modify ONLY files listed under Allowed Write Paths. Any other file edit will fail the lane.`,
    `- Fulfill all task objectives directly.`,
    `- Do not attempt git push, gh PR commands, or network credential access.`
  ]
  const prompt = promptLines.join("\n")

  let execResult: any
  try {
    const executor = new ModelExecutor({
      privateDir,
      workspaceDir: targetWorkspaceDir,
      maxAttempts: 3
    })

    execResult = await executor.executeLane(laneId, role, prompt)
  } finally {
    if (serenaSupervisor) {
      await serenaSupervisor.stop()
    }
  }

  // Ensure result.json exists in controlDir for the finalizer
  const resultPath = path.join(controlDir, "result.json")
  const workspaceResultPath = path.join(targetWorkspaceDir, "result.json")

  if (fs.existsSync(workspaceResultPath)) {
    fs.copyFileSync(workspaceResultPath, resultPath)
    try {
      fs.unlinkSync(workspaceResultPath)
    } catch {}
  }

  if (!fs.existsSync(resultPath)) {
    // If agent process exited without writing result.json, synthesize a result record from git changes
    const gitDetector = new GitChangeDetector({
      workspaceRoot: targetWorkspaceDir,
      baseSha: task.base_sha || "HEAD"
    })
    const changeSummary = gitDetector.detectChanges()
    const isPassing = execResult.status === "PASS"

    const syntheticResult = {
      task_id: laneId,
      lane: laneId,
      base_sha: task.base_sha,
      status: isPassing ? "PASS" : execResult.status,
      model_used: execResult.actualModel || "none",
      changed_paths: changeSummary.actualChangedPaths,
      verification_results: [
        {
          profile: task.verification_profile || "lane",
          command: "harness verification",
          exit_code: isPassing ? 0 : 1,
          passed: isPassing,
          duration_ms: 0
        }
      ],
      test_summary: {
        total: 1,
        passed: isPassing ? 1 : 0,
        failed: isPassing ? 0 : 1,
        skipped: 0
      },
      policy_violations: [],
      findings_fixed: [],
      remaining_blockers: isPassing ? [] : [execResult.error || "Agent terminated without result manifest"],
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
