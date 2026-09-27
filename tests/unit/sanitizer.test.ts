import { describe, it, expect } from "vitest"
import { sanitizePublicLog, formatPublicSummary, containsSensitiveData } from "../../harness/logging/sanitizer.js"

describe("Log Sanitizer", () => {
  it("removes GitHub PAT, Bearer tokens, and Doppler tokens", () => {
    const raw = `
      Error occurred while fetching:
      Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcnh5iMGWOTICnnYFlQbfSo3MaIFECewhNx4wRkg
      Doppler token: dp.st.prod_abcdef1234567890abcdef1234567890
      GitHub PAT: ghp_1234567890abcdefghijklmnopqrstuvwxyzAB
      GitHub OAuth: gho_0987654321zyxwvutsrqponmlkjihgfedcBA
    `

    const sanitized = sanitizePublicLog(raw)

    expect(sanitized).not.toContain("ghp_")
    expect(sanitized).not.toContain("gho_")
    expect(sanitized).not.toContain("dp.st.")
    expect(sanitized).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")
    expect(sanitized).toContain("[REDACTED_TOKEN]")
  })

  it("removes private key blocks", () => {
    const raw = `
      -----BEGIN RSA PRIVATE KEY-----
      MIIEowIBAAKCAQEA0Y123456789abcdefghijklmnopqrstuvwxyz
      fakebase64contentherefakebase64contentherefakebase64==
      -----END RSA PRIVATE KEY-----
    `

    const sanitized = sanitizePublicLog(raw)

    expect(sanitized).not.toContain("BEGIN RSA PRIVATE KEY")
    expect(sanitized).not.toContain("fakebase64contenthere")
    expect(sanitized).toContain("[REDACTED_PRIVATE_KEY]")
  })

  it("removes credentials from URLs", () => {
    const raw = `
      Clone URL: https://x-access-token:ghs_secrettoken12345@github.com/oaslananka/otonom.git
      API Request: https://api.example.com/v1/webhook?token=my_secret_token_123&env=prod
    `

    const sanitized = sanitizePublicLog(raw)

    expect(sanitized).not.toContain("ghs_secrettoken12345")
    expect(sanitized).not.toContain("my_secret_token_123")
    expect(sanitized).toContain("https://[REDACTED_AUTH]@github.com/oaslananka/otonom.git")
    expect(sanitized).toContain("token=[REDACTED]")
  })

  it("removes git diff patches and source markers", () => {
    const raw = `
      diff --git a/src/secret-algorithm.ts b/src/secret-algorithm.ts
      index 1234567..89abcdef 100644
      --- a/src/secret-algorithm.ts
      +++ b/src/secret-algorithm.ts
      @@ -10,4 +10,5 @@ export function computeTarget() {
       -  const baseline = 100;
       +  const proprietarySecretLogic = 42 * secretKey;
          return proprietarySecretLogic;
       }
    `

    const sanitized = sanitizePublicLog(raw)

    expect(sanitized).not.toContain("proprietarySecretLogic")
    expect(sanitized).not.toContain("@@ -10,4 +10,5 @@")
    expect(sanitized).toContain("[DIFF_REDACTED]")
  })

  it("strips ANSI color codes and control characters", () => {
    const raw = "\u001b[31mError:\u001b[0m \u001b[1mCommand failed\u001b[0m"
    const sanitized = sanitizePublicLog(raw)
    expect(sanitized).toBe("Error: Command failed")
  })

  it("detects sensitive data presence with containsSensitiveData", () => {
    expect(containsSensitiveData("Here is dp.st.live1234567890abcdef")).toBe(true)
    expect(containsSensitiveData("Here is ghp_abcd1234efgh5678ijkl9012mnop3456qrst")).toBe(true)
    expect(containsSensitiveData("Normal build message: 14 tests passed")).toBe(false)
  })

  it("formats bounded public summary according to contract", () => {
    const summary = formatPublicSummary({
      lane: "webhook-durability",
      status: "PASS",
      filesChanged: 7,
      testsPassed: 41,
      testsFailed: 0,
      policyViolations: 0,
      durationMs: 14200
    })

    expect(summary).toContain("lane: webhook-durability")
    expect(summary).toContain("status: PASS")
    expect(summary).toContain("files_changed: 7")
    expect(summary).toContain("tests_passed: 41")
    expect(summary).toContain("tests_failed: 0")
    expect(summary).toContain("policy_violations: 0")
  })
})
