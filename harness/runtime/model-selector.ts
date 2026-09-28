/**
 * Free Model Selection & Fallback Layer
 * Abstracts OpenCode free-tier model selection without requiring external model API keys.
 * Supports role-based preference profiles and clean fallback upon STALLED or rate-limit.
 */

import { execSync } from "node:child_process"

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
  customChains?: Record<string, string[]>
  autoDiscover?: boolean
}

export class ModelSelector {
  private availableCatalog?: Set<string>
  private roleChains: Record<string, string[]>

  private defaultChain: string[] = [
    "opencode/mimo-v2.6-flash-free",
    "opencode/nemotron-3.5-lightning-free",
    "opencode/ling-3.0-flash-fin-free",
    "opencode/muse-spark-1.3-contributor-free",
    "opencode/longcat-2.5-preview-free",
    "opencode/space-bunny-free"
  ]

  private executionHistory: Map<string, ModelAttempt[]> = new Map()

  public static isSafeFreeModel(model: string): boolean {
    const normalized = model.replace(":", "/")
    return normalized.startsWith("opencode/") && normalized.includes("-free")
  }

  constructor(options?: ModelSelectorOptions) {
    if (options?.customChains) {
      this.roleChains = { ...options.customChains }
    } else {
      this.roleChains = {
        "builder-core": [...this.defaultChain],
        "builder-db": [...this.defaultChain],
        "reviewer-cross-system": [...this.defaultChain],
        "security-reviewer": [...this.defaultChain],
        "ci-reviewer": [...this.defaultChain],
        "ui-builder": [...this.defaultChain],
        "integration-reviewer": [...this.defaultChain],
        "final-auditor": [...this.defaultChain]
      }
    }

    if (options?.autoDiscover) {
      const discovered = ModelSelector.discoverFreeModels()
      if (discovered.length === 0) {
        throw new Error("FREE_MODEL_UNAVAILABLE")
      }
      const normalizedDiscovered = discovered.map((m) => this.normalizeModel(m))
      this.availableCatalog = new Set(normalizedDiscovered)
      const orderByPreference = (chain: string[]) => {
        const preferred = chain
          .map((m) => this.normalizeModel(m))
          .filter((m) => this.availableCatalog!.has(m))
        const remaining = normalizedDiscovered.filter((m) => !preferred.includes(m))
        return [...preferred, ...remaining]
      }
      for (const role of Object.keys(this.roleChains)) {
        this.roleChains[role] = orderByPreference(this.roleChains[role])
      }
      this.defaultChain = orderByPreference(this.defaultChain)
    } else if (options?.availableCatalog) {
      this.availableCatalog = new Set(
        options.availableCatalog
          .map((m) => this.normalizeModel(m))
          .filter((m) => ModelSelector.isSafeFreeModel(m))
      )
    }
  }

  public static discoverFreeModels(): string[] {
    try {
      const output = execSync("opencode models", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000
      })
      const lines = output.split(/\r?\n/).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim()).filter(Boolean)
      return lines.filter((m) => ModelSelector.isSafeFreeModel(m))
    } catch {}
    return []
  }

  public normalizeModel(model: string): string {
    return model.replace(":", "/")
  }

  public selectModelForRole(role: string): string {
    const candidate = this.getFallbackModel(role, [])
    if (candidate) return candidate
    throw new Error("FREE_MODEL_UNAVAILABLE")
  }

  public getAllModelsForRole(role: string): string[] {
    const chain = this.roleChains[role] || this.defaultChain
    if (!this.availableCatalog) return chain.filter((m) => ModelSelector.isSafeFreeModel(m))
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
      if (!ModelSelector.isSafeFreeModel(norm)) {
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
