/**
 * Environment Sanitization Policy
 * Strips sensitive variables (Doppler, GitHub tokens, cloud keys) from agent shell processes.
 * Enforces safe CI environment variables.
 */

const SENSITIVE_PATTERNS: RegExp[] = [
  /^DOPPLER_/i,
  /^GITHUB_TOKEN$/i,
  /^GH_TOKEN$/i,
  /^GITHUB_PAT$/i,
  /^ACTIONS_RUNTIME_TOKEN$/i,
  /^ACTIONS_ID_TOKEN_REQUEST_TOKEN$/i,
  /^ACTIONS_ID_TOKEN_REQUEST_URL$/i,
  /^AWS_SECRET_ACCESS_KEY$/i,
  /^AWS_SESSION_TOKEN$/i,
  /^DATABASE_URL$/i,
  /^PGPASSWORD$/i,
  /^PRIVATE_KEY/i,
  /SECRET/i,
  /API_KEY/i,
  /AUTH_TOKEN/i,
  /PASSWORD/i,
  /BEARER/i
]

const SAFE_EXCEPTIONS: string[] = [
  "CI",
  "NODE_ENV",
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TERM",
  "SHELL",
  "PWD",
  "HOSTNAME",
  "TEMP",
  "TMP",
  "TMPDIR"
]

export function isSensitiveKey(key: string): boolean {
  if (SAFE_EXCEPTIONS.includes(key.toUpperCase())) {
    return false
  }
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(key))
}

export function sanitizeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {}

  for (const [key, val] of Object.entries(env)) {
    if (val === undefined) continue
    if (isSensitiveKey(key)) {
      continue
    }
    result[key] = val
  }

  // Inject required safe CI defaults
  result.CI = "1"
  result.GIT_TERMINAL_PROMPT = "0"
  result.GIT_PAGER = "cat"
  result.PAGER = "cat"
  result.NO_COLOR = "1"
  result.OPENCODE_DISABLE_LSP_DOWNLOAD = "true"

  return result
}
