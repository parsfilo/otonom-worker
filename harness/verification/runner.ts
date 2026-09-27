import { spawnSync } from "node:child_process"

export type VerificationProfile = "targeted" | "lane" | "full" | "review-only" | string

export interface VerificationResult {
  profile: string
  command: string
  exit_code: number
  passed: boolean
  duration_ms: number
  stdout_fingerprint?: string
  sanitized_summary?: string
}

export interface VerificationRunnerOptions {
  customProfiles?: Record<string, string>
  cwd?: string
  timeoutMs?: number
}

const DEFAULT_PROFILES: Record<string, string> = {
  targeted: "pnpm test:targeted",
  lane: "pnpm test",
  full: "pnpm test && pnpm typecheck && pnpm lint",
  "review-only": "pnpm lint",
  "smoke-doc": "node -e \"const fs = require('fs'); const p = 'docs/swarm-smoke/phase2-harness-validation.md'; if (!fs.existsSync(p)) process.exit(1); const s = fs.statSync(p); if (!s.isFile() || s.size > 10240) process.exit(1); process.exit(0)\" && git diff --check"
}

export class VerificationRunner {
  private profiles: Record<string, string>
  private cwd: string
  private defaultTimeoutMs?: number

  constructor(options: VerificationRunnerOptions = {}) {
    this.profiles = { ...DEFAULT_PROFILES, ...(options.customProfiles || {}) }
    this.cwd = options.cwd || process.cwd()
    this.defaultTimeoutMs = options.timeoutMs
  }

  public async runProfile(
    profileName: VerificationProfile,
    timeoutMs?: number
  ): Promise<VerificationResult> {
    const command = this.profiles[profileName]
    if (!command) {
      throw new Error(`Unknown verification profile: '${profileName}'. Allowed profiles: ${Object.keys(this.profiles).join(", ")}`)
    }

    const start = Date.now()
    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs

    // Execute through shell safely using Node spawnSync
    const isWindows = process.platform === "win32"
    const shell = isWindows ? "powershell.exe" : "/bin/bash"
    const shellArgs = isWindows ? ["-NoProfile", "-Command", `${command}; exit $LASTEXITCODE`] : ["-c", command]

    const proc = spawnSync(shell, shellArgs, {
      cwd: this.cwd,
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1"
      },
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: effectiveTimeout
    })

    const duration = Date.now() - start
    const isTimeout = (proc.error as any)?.code === "ETIMEDOUT"
    const exitCode = isTimeout ? 124 : (proc.status ?? (proc.error ? 1 : 0))
    const passed = !isTimeout && exitCode === 0

    let summary = passed ? "Verification PASSED" : `Verification FAILED with exit code ${exitCode}`
    if (isTimeout) {
      summary = `Verification TIMED OUT after ${effectiveTimeout}ms`
    }

    return {
      profile: profileName,
      command,
      exit_code: exitCode,
      passed,
      duration_ms: duration,
      sanitized_summary: summary
    }
  }
}
