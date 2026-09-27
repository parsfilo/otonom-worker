import fs from "node:fs"
import path from "node:path"

export const FORBIDDEN_ENV_VARS = [
  "DOPPLER_TOKEN",
  "OTONOM_SOURCE_CLONE_TOKEN",
  "OTONOM_TARGET_WRITE_TOKEN",
  "GITHUB_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL"
] as const

export const FORBIDDEN_GIT_CONFIG_PATTERNS = [
  /github_pat_[a-zA-Z0-9_]+/i,
  /ghp_[a-zA-Z0-9_]+/i,
  /x-access-token/i,
  /bearer\s+[a-zA-Z0-9_\-\.]+/i,
  /authorization:\s*basic/i,
  /authorization:\s*bearer/i,
  /extraheader\s*=\s*authorization/i,
  /https?:\/\/[^@\s]+:[^@\s]+@github\.com/i // embedded username:token URL
]

export function assertAgentSecretBoundary(
  env: Record<string, string | undefined>,
  targetWorkspaceDir?: string
): void {
  // 1. Assert forbidden environment variables are completely absent
  for (const varName of FORBIDDEN_ENV_VARS) {
    const val = env[varName]
    if (val !== undefined && val.trim().length > 0) {
      throw new Error(
        `Security boundary violation: forbidden environment variable '${varName}' present in agent environment. Fail closed.`
      )
    }
  }

  // 2. Assert target .git/config contains no persisted credentials or tokens
  if (targetWorkspaceDir) {
    const gitConfigFile = path.join(targetWorkspaceDir, ".git", "config")
    if (fs.existsSync(gitConfigFile)) {
      const configContent = fs.readFileSync(gitConfigFile, "utf-8")
      for (const pattern of FORBIDDEN_GIT_CONFIG_PATTERNS) {
        if (pattern.test(configContent)) {
          throw new Error(
            `Security boundary violation: target .git/config contains forbidden credential pattern. Fail closed.`
          )
        }
      }
    }
  }

  // 3. Public summary output (as required by prompt)
  console.log("agent_secret_boundary: PASS")
}
