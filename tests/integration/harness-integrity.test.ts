import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import yaml from "yaml"
import { sanitizePublicLog, containsSensitiveData } from "../../harness/logging/sanitizer.js"

describe("Harness Integrity & Static Policies", () => {
  const rootDir = process.cwd()

  describe("Test 25: Vendored Skill Provenance Validator", () => {
    it("verifies that all vendored skills match entries in toolchain.lock.json with upstream commits", () => {
      const lockfilePath = path.join(rootDir, "config/toolchain.lock.json")
      expect(fs.existsSync(lockfilePath)).toBe(true)

      const lockfile = JSON.parse(fs.readFileSync(lockfilePath, "utf-8"))
      const vendored = lockfile.vendored_skills

      expect(vendored.superpowers.upstream_repo).toBe("https://github.com/obra/superpowers")
      expect(vendored.superpowers.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(vendored.superpowers.skills.length).toBeGreaterThan(0)

      expect(vendored.trail_of_bits.upstream_repo).toBe("https://github.com/trailofbits/skills")
      expect(vendored.trail_of_bits.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(vendored.trail_of_bits.skills.length).toBeGreaterThan(0)

      // Ensure every claimed skill directory actually exists
      for (const skillName of vendored.superpowers.skills) {
        const skillDir = path.join(rootDir, ".agents/skills", skillName)
        expect(fs.existsSync(path.join(skillDir, "SKILL.md"))).toBe(true)
      }
      for (const skillName of vendored.trail_of_bits.skills) {
        const skillDir = path.join(rootDir, ".agents/skills", skillName)
        expect(fs.existsSync(path.join(skillDir, "SKILL.md"))).toBe(true)
      }
    })
  })

  describe("Test 26: Public Log Sanitizer Integration Test", () => {
    it("scrubs complex adversarial multiline payload without leaking tokens or private source", () => {
      const adversarialLog = `
[STEP 1] Starting agent with env:
DOPPLER_TOKEN=dp.st.live_99887766554433221100aabbccddeeff
GITHUB_PAT=ghp_ABCDefgh1234567890ijklmnopQRSTUVwxyz12
ACCESS_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature123456789
API_CALL=https://user:ghs_temporaryToken998877@github.com/oaslananka/otonom.git?token=secretQueryVal123

[STEP 2] Compiler error on private file:
diff --git a/src/core/proprietary-engine.ts b/src/core/proprietary-engine.ts
--- a/src/core/proprietary-engine.ts
+++ b/src/core/proprietary-engine.ts
@@ -1,5 +1,6 @@
-export function calculateTrade() {
+export function calculateTrade(secretFactor: number) {
+  const proprietaryLogic = secretFactor * 1000;
   return proprietaryLogic;
 }

[STEP 3] Private SSH key dump attempt:
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABlwAAAAdzc2gtcn
NhAAAAAwEAAQAAAYEA0123456789abcdefghijklmnopqrstuvwxyz
-----END OPENSSH PRIVATE KEY-----

[STEP 4] ANSI formatting:
\u001b[31;1mFATAL ERROR IN RUNNER\u001b[0m
`

      const sanitized = sanitizePublicLog(adversarialLog)

      // Confirm all sensitive tokens and markers are removed
      expect(sanitized).not.toContain("dp.st.")
      expect(sanitized).not.toContain("ghp_")
      expect(sanitized).not.toContain("ghs_")
      expect(sanitized).not.toContain("secretQueryVal123")
      expect(sanitized).not.toContain("doNotLeakThisSignature")
      expect(sanitized).not.toContain("proprietaryLogic")
      expect(sanitized).not.toContain("calculateTrade(secretFactor")
      expect(sanitized).not.toContain("OPENSSH PRIVATE KEY")
      expect(sanitized).not.toContain("\u001b[31;1m")

      // Confirm redaction placeholders exist
      expect(sanitized).toContain("[REDACTED_TOKEN]")
      expect(sanitized).toContain("[REDACTED_AUTH]")
      expect(sanitized).toContain("[DIFF_REDACTED]")
      expect(sanitized).toContain("[REDACTED_PRIVATE_KEY]")
      expect(sanitized).toContain("FATAL ERROR IN RUNNER")

      // Verification that containsSensitiveData evaluates false on the cleaned text
      expect(containsSensitiveData(sanitized)).toBe(false)
    })
  })

  describe("Test 27: GitHub Workflow Static Checks", () => {
    it("validates swarm.yml trigger restrictions, permissions, and matrix controls", () => {
      const swarmPath = path.join(rootDir, ".github/workflows/swarm.yml")
      expect(fs.existsSync(swarmPath)).toBe(true)

      const content = fs.readFileSync(swarmPath, "utf-8")
      const parsed = yaml.parse(content)

      // 1. Trigger restriction: ONLY workflow_dispatch
      const triggers = Object.keys(parsed.on || {})
      expect(triggers).toEqual(["workflow_dispatch"])
      expect(parsed.on.pull_request).toBeUndefined()
      expect(parsed.on.pull_request_target).toBeUndefined()
      expect(parsed.on.issue_comment).toBeUndefined()
      expect(parsed.on.issues).toBeUndefined()

      // 2. Least privilege workflow permissions
      expect(parsed.permissions).toEqual({ contents: "read" })

      // 3. Max parallel constraint
      const maxParallelInput = parsed.on.workflow_dispatch.inputs.max_parallel
      expect(maxParallelInput).toBeDefined()

      // 4. Matrix fail-fast must be false
      const agentJob = parsed.jobs["run-agent"]
      expect(agentJob.strategy["fail-fast"]).toBe(false)
    })

    it("validates harness-ci.yml does not run autonomous agents", () => {
      const ciPath = path.join(rootDir, ".github/workflows/harness-ci.yml")
      expect(fs.existsSync(ciPath)).toBe(true)

      const content = fs.readFileSync(ciPath, "utf-8")
      const parsed = yaml.parse(content)

      expect(parsed.on.push).toBeDefined()
      expect(parsed.on.pull_request).toBeDefined()

      // Ensure no opencode agent invocation in harness CI
      expect(content).not.toContain("opencode run")
    })
  })
})
