/**
 * Free Model Selection & Fallback Layer
 * Abstracts OpenCode free-tier model selection without requiring external model API keys.
 * Supports role-based preference profiles and clean fallback upon STALLED or rate-limit.
 */

export interface ModelAttempt {
  lane: string
  role: string
  model: string
  status: "PASS" | "FAIL" | "STALLED" | "RATE_LIMITED"
  timestamp: string
}

export class ModelSelector {
  // Pinned fallback chains for OpenCode free models
  private roleChains: Record<string, string[]> = {
    "builder-core": [
      "zen:gemini-2.5-flash",
      "zen:qwen-2.5-coder-32b",
      "zen:deepseek-v3",
      "zen:llama-3.3-70b"
    ],
    "builder-db": [
      "zen:gemini-2.5-flash",
      "zen:deepseek-v3",
      "zen:qwen-2.5-coder-32b"
    ],
    "reviewer-cross-system": [
      "zen:deepseek-v3",
      "zen:gemini-2.5-flash",
      "zen:llama-3.3-70b"
    ],
    "security-reviewer": [
      "zen:deepseek-v3",
      "zen:llama-3.3-70b",
      "zen:gemini-2.5-flash"
    ],
    "ci-reviewer": [
      "zen:gemini-2.5-flash",
      "zen:qwen-2.5-coder-32b"
    ],
    "ui-builder": [
      "zen:gemini-2.5-flash",
      "zen:qwen-2.5-coder-32b"
    ],
    "integration-reviewer": [
      "zen:deepseek-v3",
      "zen:gemini-2.5-flash"
    ],
    "final-auditor": [
      "zen:deepseek-v3",
      "zen:gemini-2.5-flash"
    ]
  }

  private defaultChain: string[] = [
    "zen:gemini-2.5-flash",
    "zen:deepseek-v3",
    "zen:qwen-2.5-coder-32b",
    "zen:llama-3.3-70b"
  ]

  private executionHistory: Map<string, ModelAttempt[]> = new Map()

  public selectModelForRole(role: string): string {
    const chain = this.roleChains[role] || this.defaultChain
    return chain[0]
  }

  public getAllModelsForRole(role: string): string[] {
    return [...(this.roleChains[role] || this.defaultChain)]
  }

  public getFallbackModel(role: string, alreadyAttempted: string[]): string | null {
    const chain = this.roleChains[role] || this.defaultChain
    for (const candidate of chain) {
      if (!alreadyAttempted.includes(candidate)) {
        return candidate
      }
    }
    return null
  }

  public recordAttempt(
    lane: string,
    role: string,
    model: string,
    status: "PASS" | "FAIL" | "STALLED" | "RATE_LIMITED"
  ) {
    const attempts = this.executionHistory.get(lane) || []
    attempts.push({
      lane,
      role,
      model,
      status,
      timestamp: new Date().toISOString()
    })
    this.executionHistory.set(lane, attempts)
  }

  public getLaneHistory(lane: string): ModelAttempt[] {
    return this.executionHistory.get(lane) || []
  }

  public getActiveModelForLane(lane: string): string | undefined {
    const history = this.executionHistory.get(lane)
    if (!history || history.length === 0) return undefined
    return history[history.length - 1].model
  }
}
