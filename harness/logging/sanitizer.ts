/**
 * Public Log Sanitizer
 * Guarantees that public GitHub Actions logs never emit:
 * - Private source snippets or git diffs
 * - Tokens (Doppler, GitHub PAT, JWTs)
 * - Private keys
 * - Sensitive query params or embedded URL credentials
 * - ANSI control characters
 */

const ANSI_REGEX = /\u001b\[[0-9;]*[a-zA-Z]/g
const PRIVATE_KEY_REGEX = /-----BEGIN (?:[A-Z0-9_-]+\s+)*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9_-]+\s+)*PRIVATE KEY-----/g
const GITHUB_TOKEN_REGEX = /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,255}\b/g
const DOPPLER_TOKEN_REGEX = /\bdp\.(st|pt|sa|sc)\.[A-Za-z0-9_]{15,255}\b/g
const BEARER_JWT_REGEX = /\bBearer\s+eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gi
const STANDALONE_JWT_REGEX = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
const URL_AUTH_REGEX = /(https?:\/\/)([^:\s\/]+):([^@\s\/]+)@/g
const QUERY_PARAM_REGEX = /([?&](?:token|access_token|secret|api_key|password)=)(?!\[REDACTED\])[^&\s]+/gi
const DIFF_BLOCK_REGEX = /diff --git a\/[\s\S]*?(?=(\n\s*\n\s*[^ +-]|diff --git|$))/g
const HUNK_HEADER_REGEX = /@@ -\d+,\d+ \+\d+,\d+ @@[\s\S]*?(?=(\n\s*\n\s*[^ +-]|@@|$))/g

export function sanitizePublicLog(rawText: string): string {
  if (!rawText) return ""

  let text = rawText

  // 1. Strip ANSI escape sequences
  text = text.replace(ANSI_REGEX, "")

  // 2. Redact private keys
  text = text.replace(PRIVATE_KEY_REGEX, "[REDACTED_PRIVATE_KEY]")

  // 3. Redact git diffs and patches
  if (text.includes("diff --git") || text.includes("@@ -")) {
    text = text.replace(DIFF_BLOCK_REGEX, "[DIFF_REDACTED]")
    text = text.replace(HUNK_HEADER_REGEX, "[DIFF_REDACTED]")
  }

  // 4. Redact tokens
  text = text.replace(GITHUB_TOKEN_REGEX, "[REDACTED_TOKEN]")
  text = text.replace(DOPPLER_TOKEN_REGEX, "[REDACTED_TOKEN]")
  text = text.replace(BEARER_JWT_REGEX, "Bearer [REDACTED_TOKEN]")
  text = text.replace(STANDALONE_JWT_REGEX, "[REDACTED_TOKEN]")

  // 5. Redact URL embedded credentials
  text = text.replace(URL_AUTH_REGEX, "$1[REDACTED_AUTH]@")

  // 6. Redact URL query secrets (excluding already redacted markers)
  text = text.replace(QUERY_PARAM_REGEX, "$1[REDACTED]")

  return text.trim()
}

export function containsSensitiveData(text: string): boolean {
  if (!text) return false

  const hasKey = /-----BEGIN (?:[A-Z0-9_-]+\s+)*PRIVATE KEY-----/.test(text)
  const hasGhToken = /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,255}\b/.test(text)
  const hasDoppler = /\bdp\.(st|pt|sa|sc)\.[A-Za-z0-9_]{15,255}\b/.test(text)
  const hasBearer = /\bBearer\s+eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/i.test(text)
  const hasJwt = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(text)
  const hasUrlAuth = /https?:\/\/[^:\s\/]+:[^@\s\/]+@/.test(text)
  const hasQuerySecret = /[?&](?:token|access_token|secret|api_key|password)=(?!\[REDACTED\])[^&\s]+/i.test(text)

  return hasKey || hasGhToken || hasDoppler || hasBearer || hasJwt || hasUrlAuth || hasQuerySecret
}

export interface PublicSummaryMetrics {
  lane: string
  status: "PASS" | "FAIL" | "STALLED" | "POLICY_VIOLATION"
  filesChanged: number
  testsPassed: number
  testsFailed: number
  policyViolations: number
  durationMs?: number
}

export function formatPublicSummary(metrics: PublicSummaryMetrics): string {
  const lines = [
    `lane: ${metrics.lane}`,
    `status: ${metrics.status}`,
    `files_changed: ${metrics.filesChanged}`,
    `tests_passed: ${metrics.testsPassed}`,
    `tests_failed: ${metrics.testsFailed}`,
    `policy_violations: ${metrics.policyViolations}`
  ]

  if (metrics.durationMs !== undefined) {
    lines.push(`duration_seconds: ${(metrics.durationMs / 1000).toFixed(1)}`)
  }

  return lines.join("\n")
}
