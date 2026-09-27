import fs from "node:fs"
import path from "node:path"
import { evaluateLaneCompletion } from "../../harness/verification/completion-gate.js"
import { validateResult } from "../../harness/validation/schema-validator.js"
import { VerificationResult } from "../../harness/verification/runner.js"
import { PolicyViolation } from "../../harness/policies/ownership.js"

export interface CompleteLaneOptions {
  taskPath: string
  privateDir: string
  workspaceRoot: string
  resultPath?: string
  latestVerification?: VerificationResult
  ownershipViolations?: PolicyViolation[]
  changedPaths?: string[]
  unresolvedBlockers?: string[]
  modelUsed?: string
  loopMetrics?: {
    tool_repeats: number
    file_rereads: number
    stall_warnings: number
    diff_hash_changes: number
  }
}

export class CompleteLaneTool {
  constructor(private options: CompleteLaneOptions) {}

  public async execute(): Promise<{ completed: boolean; resultPath?: string; error?: string }> {
    const gateCheck = evaluateLaneCompletion({
      taskPath: this.options.taskPath,
      latestVerification: this.options.latestVerification,
      ownershipViolations: this.options.ownershipViolations || [],
      changedPaths: this.options.changedPaths || [],
      unresolvedBlockers: this.options.unresolvedBlockers
    })

    if (!gateCheck.canComplete) {
      return { completed: false, error: gateCheck.reason }
    }

    // Read task to fill result metadata
    const task = JSON.parse(fs.readFileSync(this.options.taskPath, "utf-8"))

    const resultData = {
      task_id: task.id,
      lane: task.id,
      base_sha: task.base_sha,
      status: "PASS",
      model_used: this.options.modelUsed || "free-model-zen-flash",
      changed_paths: this.options.changedPaths || [],
      verification_results: this.options.latestVerification ? [this.options.latestVerification] : [],
      test_summary: {
        total: 1,
        passed: 1,
        failed: 0,
        skipped: 0
      },
      policy_violations: this.options.ownershipViolations || [],
      findings_fixed: [],
      remaining_blockers: this.options.unresolvedBlockers || [],
      cross_lane_request_count: 0,
      loop_metrics: this.options.loopMetrics || {
        tool_repeats: 0,
        file_rereads: 0,
        stall_warnings: 0,
        diff_hash_changes: 1
      },
      completed_at: new Date().toISOString()
    }

    const validation = validateResult(resultData)
    if (!validation.valid) {
      return { completed: false, error: `Constructed result failed schema: ${validation.errors?.join("; ")}` }
    }

    const outPath = this.options.resultPath || path.join(this.options.workspaceRoot, "result.json")
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify(resultData, null, 2), "utf-8")

    return { completed: true, resultPath: outPath }
  }
}
