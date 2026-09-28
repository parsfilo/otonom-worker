import fs from "node:fs"
import path from "node:path"
import { ModelExecutor, type ModelExecutionResult } from "./model-executor.js"
import { ModelSelector } from "./model-selector.js"
import { GitChangeDetector } from "../finalizer/git-detector.js"
import { OwnershipTracker, type PolicyViolation } from "../policies/ownership.js"
import { VerificationRunner, type VerificationResult } from "../verification/runner.js"
import { validateResult } from "../validation/schema-validator.js"

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
    ...(task.verification_profile === "target-ci"
      ? [
          `- This lane defers package-manager checks to the target repository PR CI. Do not run pnpm/npm/yarn/bun/npx/corepack commands; use run_verification for trusted diff hygiene, then call complete_lane.`
        ]
      : []),
    `- Do not attempt git push, gh PR commands, or network credential access.`
  ].join("\n")
}

function resultViolation(violation: PolicyViolation) {
  return {
    policy: violation.policy,
    detail: violation.detail,
    target: violation.target,
    timestamp: violation.timestamp
  }
}

export async function reconcileTrustedLaneResult(input: {
  task: any
  execResult: ModelExecutionResult
  resultPath: string
  targetWorkspaceDir: string
}): Promise<any> {
  const { task, execResult, resultPath, targetWorkspaceDir } = input
  const detector = new GitChangeDetector({
    workspaceRoot: targetWorkspaceDir,
    baseSha: task.base_sha || "HEAD"
  })
  const changeSummary = detector.detectChanges()
  let changedPaths = changeSummary.actualChangedPaths
  const blockers: string[] = []
  const policyViolations: ReturnType<typeof resultViolation>[] = []
  let trustedVerification: VerificationResult | undefined

  if (execResult.status !== "PASS") {
    blockers.push(execResult.error || execResult.status)
  }

  if (task.requires_changes === true && changedPaths.length === 0) {
    blockers.push("NO_WORK_PRODUCT")
  }

  const ownership = new OwnershipTracker({
    allowedWritePaths: task.allowed_write_paths || [],
    forbiddenWritePaths: task.forbidden_write_paths || []
  })
  const collectPolicyViolations = (paths: string[]) => {
    for (const changedPath of paths) {
      const check = ownership.checkPath(changedPath)
      if (
        !check.allowed &&
        check.violation &&
        !policyViolations.some(
          (violation) =>
            violation.policy === check.violation!.policy &&
            violation.target === check.violation!.target
        )
      ) {
        policyViolations.push(resultViolation(check.violation))
      }
    }
  }

  collectPolicyViolations(changedPaths)

  if (policyViolations.length > 0) {
    blockers.push("OUT_OF_SCOPE_WORK_PRODUCT")
  }

  if (blockers.length === 0) {
    try {
      const verifier = new VerificationRunner({ cwd: targetWorkspaceDir })
      trustedVerification = await verifier.runProfile(task.verification_profile || "lane")
      if (!trustedVerification.passed || trustedVerification.exit_code !== 0) {
        blockers.push(`VERIFICATION_FAILED:${task.verification_profile || "lane"}`)
      }
    } catch {
      blockers.push(`VERIFICATION_EXECUTION_FAILED:${task.verification_profile || "lane"}`)
    }
  }

  if (trustedVerification) {
    const postVerificationPaths = detector.detectChanges().actualChangedPaths
    if (postVerificationPaths.join("\0") !== changedPaths.join("\0")) {
      blockers.push("VERIFICATION_MUTATED_WORKSPACE")
      changedPaths = postVerificationPaths
      collectPolicyViolations(changedPaths)
      if (policyViolations.length > 0 && !blockers.includes("OUT_OF_SCOPE_WORK_PRODUCT")) {
        blockers.push("OUT_OF_SCOPE_WORK_PRODUCT")
      }
    }
  }

  const passed = blockers.length === 0 && policyViolations.length === 0 && execResult.status === "PASS"
  const verificationResults = trustedVerification ? [trustedVerification] : []
  const result = {
    task_id: task.id,
    lane: task.id,
    base_sha: task.base_sha,
    status: passed ? "PASS" : "FAIL",
    model_used: execResult.actualModel || "none",
    changed_paths: changedPaths,
    verification_results: verificationResults,
    test_summary: {
      total: verificationResults.length,
      passed: verificationResults.filter((v) => v.passed).length,
      failed: passed ? 0 : Math.max(1, verificationResults.filter((v) => !v.passed).length),
      skipped: 0
    },
    policy_violations: policyViolations,
    findings_fixed: [],
    remaining_blockers: blockers,
    cross_lane_request_count: 0,
    loop_metrics: {
      tool_repeats: 0,
      file_rereads: 0,
      stall_warnings: 0,
      diff_hash_changes: changedPaths.length
    },
    completed_at: new Date().toISOString()
  }

  const validation = validateResult(result)
  if (!validation.valid) {
    throw new Error(`TRUSTED_RESULT_SCHEMA_INVALID: ${validation.errors?.join("; ")}`)
  }

  fs.mkdirSync(path.dirname(resultPath), { recursive: true })
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), "utf-8")
  return result
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

  fs.writeFileSync(path.join(privateDir, "sentinel.log"), "PRIVATE_LOG_SENTINEL_PHASE2\n")

  const prompt = buildTaskPrompt(task)
  const selector = new ModelSelector({ autoDiscover: true })
  const opencodeConfigDir = path.join(controlDir, "opencode")
  const executor = new ModelExecutor({
    selector,
    privateDir,
    workspaceDir: targetWorkspaceDir,
    opencodeConfigPath: path.join(opencodeConfigDir, "opencode.json"),
    opencodeConfigDir,
    maxAttempts: 6,
    attemptTimeoutMs: Math.max(1, Number(task.attempt_timeout_minutes || 5)) * 60 * 1000,
    requiresChanges: task.requires_changes === true,
    baseSha: task.base_sha,
    agentEnv: {
      TASK_PATH: taskPath,
      RESULT_PATH: resultPath,
      CONTROL_DIR: controlDir,
      PRIVATE_DIR: privateDir,
      LANE_ID: laneId
    }
  })

  const execResult = await executor.executeLane(laneId, role, prompt)

  // The agent-authored completion result is telemetry only. Reconcile it from
  // trusted Git state + ownership + a fresh trusted verification profile.
  const trustedResult = await reconcileTrustedLaneResult({
    task,
    execResult,
    resultPath,
    targetWorkspaceDir
  })

  console.log(`[Run Lane] Execution completed with status: ${execResult.status}`)
  console.log(`[Run Lane] Trusted completion reconciliation: ${trustedResult.status}`)
  if (trustedResult.policy_violations?.length) {
    const targets = trustedResult.policy_violations
      .map((violation: { target?: string }) => violation.target)
      .filter((target: string | undefined): target is string => Boolean(target))
      .sort()
    if (targets.length > 0) {
      console.log(`[Run Lane] out_of_scope_paths=${targets.join(",")}`)
    }
  }
  if (trustedResult.status !== "PASS") {
    console.log(`[Run Lane Note] Trusted result is non-passing (${trustedResult.remaining_blockers.join(", ") || "policy violation"}). Finalizer will fail closed.`)
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
