import fs from "node:fs"
import { VerificationResult } from "./runner.js"
import { OwnershipTracker, PolicyViolation } from "../policies/ownership.js"

export interface CompletionGateInput {
  taskPath: string
  latestVerification?: VerificationResult
  ownershipViolations: PolicyViolation[]
  changedPaths: string[]
  unresolvedBlockers?: string[]
}

export interface CompletionGateResult {
  canComplete: boolean
  reason?: string
}

export function evaluateLaneCompletion(input: CompletionGateInput): CompletionGateResult {
  let task: any = null
  try {
    task = JSON.parse(fs.readFileSync(input.taskPath, "utf-8"))
  } catch {
    return { canComplete: false, reason: "Task contract is missing or invalid." }
  }

  if (!input.latestVerification) {
    return {
      canComplete: false,
      reason: "No verification has been run. You must run run_verification before completing the lane."
    }
  }

  if (!input.latestVerification.passed || input.latestVerification.exit_code !== 0) {
    return {
      canComplete: false,
      reason: `Latest verification failed with exit code ${input.latestVerification.exit_code}. Fix failing tests before completing.`
    }
  }

  if (input.ownershipViolations && input.ownershipViolations.length > 0) {
    return {
      canComplete: false,
      reason: `Unresolved ownership violations present (${input.ownershipViolations.length} violations recorded). Revert unauthorized edits.`
    }
  }

  if (input.unresolvedBlockers && input.unresolvedBlockers.length > 0) {
    return {
      canComplete: false,
      reason: `Unresolved blockers present: ${input.unresolvedBlockers.join(", ")}`
    }
  }

  const authoritativeOwnership = new OwnershipTracker({
    allowedWritePaths: task.allowed_write_paths || [],
    forbiddenWritePaths: task.forbidden_write_paths || []
  })
  for (const changedPath of input.changedPaths) {
    const check = authoritativeOwnership.checkPath(changedPath)
    if (!check.allowed) {
      return {
        canComplete: false,
        reason: `OUT_OF_SCOPE_WORK_PRODUCT: ${check.violation?.detail || changedPath}`
      }
    }
  }

  if (task.requires_changes === true && input.changedPaths.length === 0) {
    return {
      canComplete: false,
      reason: "NO_WORK_PRODUCT: task requires repository changes but no changed paths were detected."
    }
  }

  return { canComplete: true }
}
