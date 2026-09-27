import { VerificationResult } from "./runner.js"
import { PolicyViolation } from "../policies/ownership.js"

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
  // 1. Must have executed a verification command
  if (!input.latestVerification) {
    return {
      canComplete: false,
      reason: "No verification has been run. You must run run_verification before completing the lane."
    }
  }

  // 2. Latest verification must have passed (exit code 0)
  if (!input.latestVerification.passed || input.latestVerification.exit_code !== 0) {
    return {
      canComplete: false,
      reason: `Latest verification failed with exit code ${input.latestVerification.exit_code}. Fix failing tests before completing.`
    }
  }

  // 3. Must not have any active ownership violations
  if (input.ownershipViolations && input.ownershipViolations.length > 0) {
    return {
      canComplete: false,
      reason: `Unresolved ownership violations present (${input.ownershipViolations.length} violations recorded). Revert unauthorized edits.`
    }
  }

  // 4. Must not have unresolved blockers
  if (input.unresolvedBlockers && input.unresolvedBlockers.length > 0) {
    return {
      canComplete: false,
      reason: `Unresolved blockers present: ${input.unresolvedBlockers.join(", ")}`
    }
  }

  return { canComplete: true }
}
