import picomatch from "picomatch"

export interface OwnershipConfig {
  allowedWritePaths: string[]
  forbiddenWritePaths: string[]
}

export interface PolicyViolation {
  policy: string
  detail: string
  target: string
  timestamp: string
  reverted?: boolean
}

export class OwnershipTracker {
  private allowedMatcher: picomatch.Matcher
  private forbiddenMatcher: picomatch.Matcher | null = null
  private violations: PolicyViolation[] = []
  private editedPaths: Set<string> = new Set()

  constructor(private config: OwnershipConfig) {
    this.validateGlobs(config.allowedWritePaths, "allowedWritePaths")
    this.validateGlobs(config.forbiddenWritePaths, "forbiddenWritePaths")

    this.allowedMatcher = picomatch(config.allowedWritePaths, { dot: true })
    if (config.forbiddenWritePaths && config.forbiddenWritePaths.length > 0) {
      this.forbiddenMatcher = picomatch(config.forbiddenWritePaths, { dot: true })
    }
  }

  private validateGlobs(globs: string[], field: string) {
    if (!Array.isArray(globs)) {
      throw new Error(`Invalid glob array for ${field}`)
    }
    for (const g of globs) {
      if (typeof g !== "string" || g.trim().length === 0) {
        throw new Error(`Invalid glob in ${field}: empty or non-string`)
      }
    }
  }

  private normalizePath(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\.\//, "")
  }

  public recordEdit(filepath: string): { allowed: boolean; violation?: PolicyViolation } {
    const normalized = this.normalizePath(filepath)
    this.editedPaths.add(normalized)

    // Check forbidden paths first
    if (this.forbiddenMatcher && this.forbiddenMatcher(normalized)) {
      const violation: PolicyViolation = {
        policy: "OWNERSHIP_FORBIDDEN_WRITE",
        detail: `Attempted edit to forbidden path: ${normalized}`,
        target: normalized,
        timestamp: new Date().toISOString()
      }
      this.violations.push(violation)
      return { allowed: false, violation }
    }

    // Check allowed paths
    if (!this.allowedMatcher(normalized)) {
      const violation: PolicyViolation = {
        policy: "OUT_OF_SCOPE_WRITE",
        detail: `Attempted edit outside owned paths: ${normalized}`,
        target: normalized,
        timestamp: new Date().toISOString()
      }
      this.violations.push(violation)
      return { allowed: false, violation }
    }

    return { allowed: true }
  }

  public recordRevert(filepath: string) {
    const normalized = this.normalizePath(filepath)
    // Mark any existing violation as reverted, but keep the record!
    for (const v of this.violations) {
      if (v.target === normalized) {
        v.reverted = true
      }
    }
  }

  public getViolations(): PolicyViolation[] {
    return [...this.violations]
  }

  public hasViolations(): boolean {
    return this.violations.length > 0
  }

  public getEditedPaths(): string[] {
    return Array.from(this.editedPaths)
  }
}
