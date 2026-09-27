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
}

const DEFAULT_PROFILES: Record<string, string> = {
  targeted: "pnpm test:targeted",
  lane: "pnpm test",
  full: "pnpm test && pnpm typecheck && pnpm lint",
  "review-only": "pnpm lint"
}

export class VerificationRunner {
  private profiles: Record<string, string>
  private cwd: string

  constructor(options: VerificationRunnerOptions = {}) {
    this.profiles = { ...DEFAULT_PROFILES, ...(options.customProfiles || {}) }
    this.cwd = options.cwd || process.cwd()
  }

  public async runProfile(profileName: VerificationProfile): Promise<VerificationResult> {
    const command = this.profiles[profileName]
    if (!command) {
      throw new Error(`Unknown verification profile: '${profileName}'. Allowed profiles: ${Object.keys(this.profiles).join(", ")}`)
    }

    const start = Date.now()

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
      maxBuffer: 10 * 1024 * 1024
    })

    const duration = Date.now() - start
    const exitCode = proc.status ?? (proc.error ? 1 : 0)
    const passed = exitCode === 0

    return {
      profile: profileName,
      command,
      exit_code: exitCode,
      passed,
      duration_ms: duration,
      sanitized_summary: passed ? "Verification PASSED" : `Verification FAILED with exit code ${exitCode}`
    }
  }
}
