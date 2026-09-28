import { execFileSync } from "node:child_process"

export interface DopplerClientOptions {
  dopplerToken?: string
  mockSecrets?: Record<string, string>
}

export interface DopplerPreflightOptions {
  forceSingleAgent?: boolean
}

export interface DopplerPreflightResult {
  valid: boolean
  requiredValuesPresent: number
  effectiveParallelism: number
  errors: string[]
}

export interface SourceBootstrapConfig {
  cloneToken: string
  repoUrl: string
  baseBranch: string
  opencodeVersion?: string
}

export interface FinalizerConfigSecrets {
  targetWriteToken: string
  baseBranch: string
  committerName: string
  committerEmail: string
}

export interface MatrixConfigSecrets {
  maxParallel: number
  defaultTimeoutMinutes: number
}

export const REQUIRED_DOPPLER_KEYS = [
  "OTONOM_SOURCE_CLONE_TOKEN",
  "OTONOM_SOURCE_REPO_URL",
  "OTONOM_TARGET_WRITE_TOKEN",
  "OTONOM_TARGET_BASE_BRANCH",
  "OTONOM_GIT_COMMITTER_NAME",
  "OTONOM_GIT_COMMITTER_EMAIL",
  "SWARM_MAX_PARALLEL",
  "SWARM_DEFAULT_TIMEOUT_MINUTES",
  "OPENCODE_PINNED_VERSION",
  "OPENCODE_API_KEY"
] as const

export class TrustedDopplerClient {
  private dopplerToken?: string
  private mockSecrets?: Record<string, string>

  constructor(options: DopplerClientOptions = {}) {
    this.dopplerToken = options.dopplerToken || process.env.DOPPLER_TOKEN
    this.mockSecrets = options.mockSecrets
  }

  public getSecret(key: string): string {
    if (this.mockSecrets) {
      const val = this.mockSecrets[key]
      if (val === undefined) {
        throw new Error(`Missing required Doppler secret: ${key}`)
      }
      return val
    }

    if (!this.dopplerToken) {
      throw new Error(`DOPPLER_TOKEN is not configured for trusted Doppler access`)
    }

    try {
      const output = execFileSync(
        "doppler",
        ["secrets", "get", key, "--plain"],
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            DOPPLER_TOKEN: this.dopplerToken,
            NO_COLOR: "1"
          }
        }
      )
      return output.trim()
    } catch (err: any) {
      const stderr = err.stderr ? err.stderr.toString() : err.message
      // Never print secret or token in error message
      throw new Error(`Failed to retrieve Doppler secret '${key}': ${stderr.replace(/dp\.st\.[a-zA-Z0-9_-]+/g, "[REDACTED]")}`)
    }
  }

  public runPreflight(options: DopplerPreflightOptions = {}): DopplerPreflightResult {
    const errors: string[] = []
    let presentCount = 0

    const secrets: Record<string, string> = {}

    for (const key of REQUIRED_DOPPLER_KEYS) {
      try {
        const val = this.getSecret(key)
        if (val && val.trim().length > 0) {
          secrets[key] = val.trim()
          presentCount++
        } else {
          errors.push(`Required Doppler key '${key}' is empty`)
        }
      } catch (err: any) {
        errors.push(err.message)
      }
    }

    // 1. Validate distinct tokens (source clone != target write)
    if (secrets.OTONOM_SOURCE_CLONE_TOKEN && secrets.OTONOM_TARGET_WRITE_TOKEN) {
      if (secrets.OTONOM_SOURCE_CLONE_TOKEN === secrets.OTONOM_TARGET_WRITE_TOKEN) {
        errors.push("Security boundary violation: source token and target token must be distinct")
      }
    }

    // 2. Validate repo URL resolves to oaslananka/otonom
    if (secrets.OTONOM_SOURCE_REPO_URL) {
      const repoUrl = secrets.OTONOM_SOURCE_REPO_URL.toLowerCase()
      const isOtonomRepo =
        repoUrl.includes("github.com/oaslananka/otonom.git") ||
        repoUrl.includes("github.com/oaslananka/otonom") ||
        repoUrl === "oaslananka/otonom"

      if (!isOtonomRepo) {
        errors.push(`Security boundary violation: Target repository must resolve to 'oaslananka/otonom' (got: ${repoUrl})`)
      }
    }

    // 3. Validate target base branch
    if (secrets.OTONOM_TARGET_BASE_BRANCH) {
      const branch = secrets.OTONOM_TARGET_BASE_BRANCH
      if (!/^[a-zA-Z0-9_.-]+$/.test(branch) || branch.startsWith("-")) {
        errors.push(`Illegal target base branch name: '${branch}'`)
      }
    }

    // 4. Validate git committer name & email (no newline / control char injection)
    if (secrets.OTONOM_GIT_COMMITTER_NAME) {
      if (/[\r\n\0\x00-\x1F]/.test(secrets.OTONOM_GIT_COMMITTER_NAME)) {
        errors.push("Committer name contains illegal control characters")
      }
    }
    if (secrets.OTONOM_GIT_COMMITTER_EMAIL) {
      if (/[\r\n\0\x00-\x1F]/.test(secrets.OTONOM_GIT_COMMITTER_EMAIL)) {
        errors.push("Committer email contains illegal control characters")
      }
    }

    // 5. Validate max parallel & timeout
    let parsedParallel = 1
    if (secrets.SWARM_MAX_PARALLEL) {
      const num = parseInt(secrets.SWARM_MAX_PARALLEL, 10)
      if (isNaN(num) || num < 1 || num > 20) {
        errors.push(`SWARM_MAX_PARALLEL must be between 1 and 20 (got: ${secrets.SWARM_MAX_PARALLEL})`)
      } else {
        parsedParallel = num
      }
    }

    if (secrets.SWARM_DEFAULT_TIMEOUT_MINUTES) {
      const timeout = parseInt(secrets.SWARM_DEFAULT_TIMEOUT_MINUTES, 10)
      if (isNaN(timeout) || timeout < 5 || timeout > 120) {
        errors.push(`SWARM_DEFAULT_TIMEOUT_MINUTES must be between 5 and 120 (got: ${secrets.SWARM_DEFAULT_TIMEOUT_MINUTES})`)
      }
    }

    // For single-lane smoke, force effective parallelism to exactly 1
    const effectiveParallelism = options.forceSingleAgent ? 1 : parsedParallel

    return {
      valid: errors.length === 0,
      requiredValuesPresent: presentCount,
      effectiveParallelism,
      errors
    }
  }

  public getSourceBootstrapConfig(): SourceBootstrapConfig {
    return {
      cloneToken: this.getSecret("OTONOM_SOURCE_CLONE_TOKEN"),
      repoUrl: this.getSecret("OTONOM_SOURCE_REPO_URL"),
      baseBranch: this.getSecret("OTONOM_TARGET_BASE_BRANCH") || "main",
      opencodeVersion: this.getSecret("OPENCODE_PINNED_VERSION") || "1.18.32"
    }
  }

  public getFinalizerConfig(): FinalizerConfigSecrets {
    return {
      targetWriteToken: this.getSecret("OTONOM_TARGET_WRITE_TOKEN"),
      baseBranch: this.getSecret("OTONOM_TARGET_BASE_BRANCH") || "main",
      committerName: this.getSecret("OTONOM_GIT_COMMITTER_NAME"),
      committerEmail: this.getSecret("OTONOM_GIT_COMMITTER_EMAIL")
    }
  }

  public getMatrixConfig(): MatrixConfigSecrets {
    const rawParallel = parseInt(this.getSecret("SWARM_MAX_PARALLEL") || "1", 10)
    const rawTimeout = parseInt(this.getSecret("SWARM_DEFAULT_TIMEOUT_MINUTES") || "30", 10)

    return {
      maxParallel: isNaN(rawParallel) ? 1 : Math.min(rawParallel, 20),
      defaultTimeoutMinutes: isNaN(rawTimeout) ? 30 : rawTimeout
    }
  }

  public logPreflightSummary(result: DopplerPreflightResult): void {
    if (result.valid) {
      console.log(`doppler_preflight: PASS`)
      console.log(`required_values_present: ${result.requiredValuesPresent}`)
      console.log(`effective_parallelism: ${result.effectiveParallelism}`)
    } else {
      console.error(`doppler_preflight: FAIL`)
      console.error(`required_values_present: ${result.requiredValuesPresent}`)
      for (const err of result.errors) {
        console.error(`  - ${err}`)
      }
    }
  }
}
