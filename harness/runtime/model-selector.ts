/**
 * Free Model Selection & Fallback Layer
 * Abstracts OpenCode free-tier model selection without requiring external model API keys.
 * Supports role-based preference profiles and clean fallback upon STALLED or rate-limit.
 */

export type ModelAttemptStatus = "PASS" | "FAIL" | "STALLED" | "RATE_LIMITED" | "UNAVAILABLE"

export interface ModelAttempt {
  lane: string
  role: string
  model: string
  status: ModelAttemptStatus
  timestamp: string
}

export interface ModelSelectorOptions {
  availableCatalog?: string[]
}

export class ModelSelector {
  private availableCatalog?: Set<string>

  // Pinned fallback chains for OpenCode free models using provider/model syntax
  private roleChains: Record<string, string[]> = {
    "builder-core": [
      "zen/gemini-2.5-flash",
      "zen/qwen-2.5-coder-32b",
      "zen/deepseek-v3",
      "zen/llama-3.3-70b"
    ],
    "builder-db": [
      "zen/gemini-2.5-flash",
      "zen/deepseek-v3",
      "zen/qwen-2.5-coder-32b"
    ],
    "reviewer-cross-system": [
      "zen/deepseek-v3",
      "zen/gemini-2.5-flash",
      "zen/llama-3.3-70b"
    ],
    "security-reviewer": [
      "zen/deepseek-v3",
      "zen/llama-3.3-70b",
      "zen/gemini-2.5-flash"
    ],
    "ci-reviewer": [
      "zen/gemini-2.5-flash",
      "zen/qwen-2.5-coder-32b"
    ],
    "ui-builder": [
      "zen/gemini-2.5-flash",
      "zen/qwen-2.5-coder-32b"
    ],
    "integration-reviewer": [
      "zen/deepseek-v3",
      "zen/gemini-2.5-flash"
    ],
    "final-auditor": [
      "zen/deepseek-v3",
      "zen/gemini-2.5-flash"
    ]
  }

  private defaultChain: string[] = [
    "zen/gemini-2.5-flash",
    "zen/deepseek-v3",
    "zen/qwen-2.5-coder-32b",
    "zen/llama-3.3-70b"
  ]

  private executionHistory: Map<string, ModelAttempt[]> = new Map()

  constructor(options?: ModelSelectorOptions) {
    if (options?.availableCatalog) {
      this.availableCatalog = new Set(options.availableCatalog.map(m => this.normalizeModel(m)))
    }
  }

  public normalizeModel(model: string): string {
    return model.replace(":", "/")
  }

  public selectModelForRole(role: string): string {
    const candidate = this.getFallbackModel(role, [])
    if (candidate) return candidate
    const chain = this.roleChains[role] || this.defaultChain
    return chain[0]
  }

  public getAllModelsForRole(role: string): string[] {
    const chain = this.roleChains[role] || this.defaultChain
    if (!this.availableCatalog) return [...chain]
    return chain.filter(m => this.availableCatalog!.has(m))
  }

  public getFallbackModel(role: string, alreadyAttempted: string[]): string | null {
    const chain = this.roleChains[role] || this.defaultChain
    const normalizedAttempted = new Set(alreadyAttempted.map(m => this.normalizeModel(m)))

    for (const candidate of chain) {
      const norm = this.normalizeModel(candidate)
      if (normalizedAttempted.has(norm)) {
        continue
      }
      if (this.availableCatalog && !this.availableCatalog.has(norm)) {
        continue
      }
      return norm
    }
    return null
  }

  public recordAttempt(
    lane: string,
    role: string,
    model: string,
    status: ModelAttemptStatus
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
