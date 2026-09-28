import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { TrustedDopplerClient, DopplerPreflightResult } from "../../harness/doppler/client.js"

describe("TrustedDopplerClient & Preflight", () => {
  const validMockSecrets: Record<string, string> = {
    OTONOM_SOURCE_CLONE_TOKEN: "ghp_source_mock_token_12345",
    OTONOM_SOURCE_REPO_URL: "https://github.com/oaslananka/otonom.git",
    OTONOM_TARGET_WRITE_TOKEN: "ghp_target_mock_token_67890",
    OTONOM_TARGET_BASE_BRANCH: "main",
    OTONOM_GIT_COMMITTER_NAME: "OTONOM Swarm Bot",
    OTONOM_GIT_COMMITTER_EMAIL: "swarm-bot@otonom.internal",
    SWARM_MAX_PARALLEL: "5",
    SWARM_DEFAULT_TIMEOUT_MINUTES: "30",
    OPENCODE_PINNED_VERSION: "1.18.32",
    OPENCODE_API_KEY: "oc-test-provider-credential"
  }

  it("preflight succeeds with valid configuration and forces effective parallelism to 1", () => {
    const client = new TrustedDopplerClient({
      mockSecrets: validMockSecrets,
      dopplerToken: "dp.st.mock_token"
    })

    const result = client.runPreflight({ forceSingleAgent: true })

    expect(result.valid).toBe(true)
    expect(result.requiredValuesPresent).toBe(10)
    expect(result.effectiveParallelism).toBe(1)
    expect(result.errors).toHaveLength(0)
  })

  it("preflight fails if a required Doppler key is missing", () => {
    const incompleteSecrets = { ...validMockSecrets }
    delete (incompleteSecrets as any).OTONOM_TARGET_WRITE_TOKEN

    const client = new TrustedDopplerClient({
      mockSecrets: incompleteSecrets,
      dopplerToken: "dp.st.mock_token"
    })

    const result = client.runPreflight()

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("Missing required Doppler secret: OTONOM_TARGET_WRITE_TOKEN")])
    )
  })

  it("preflight fails if source token and target token are identical (boundary violation)", () => {
    const leakedSecrets = {
      ...validMockSecrets,
      OTONOM_TARGET_WRITE_TOKEN: "ghp_source_mock_token_12345" // identical to source token
    }

    const client = new TrustedDopplerClient({
      mockSecrets: leakedSecrets,
      dopplerToken: "dp.st.mock_token"
    })

    const result = client.runPreflight()

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("source token and target token must be distinct")])
    )
  })

  it("preflight fails if repository URL is not oaslananka/otonom", () => {
    const badRepoSecrets = {
      ...validMockSecrets,
      OTONOM_SOURCE_REPO_URL: "https://github.com/malicious/repo.git"
    }

    const client = new TrustedDopplerClient({
      mockSecrets: badRepoSecrets,
      dopplerToken: "dp.st.mock_token"
    })

    const result = client.runPreflight()

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("Target repository must resolve to 'oaslananka/otonom'")])
    )
  })

  it("preflight fails if committer name contains control character injection", () => {
    const injectedSecrets = {
      ...validMockSecrets,
      OTONOM_GIT_COMMITTER_NAME: "Bot\nInjected-Header: evil"
    }

    const client = new TrustedDopplerClient({
      mockSecrets: injectedSecrets,
      dopplerToken: "dp.st.mock_token"
    })

    const result = client.runPreflight()

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("Committer name contains illegal control characters")])
    )
  })

  it("retrieves only scoped bootstrap config without exposing target write credentials", () => {
    const client = new TrustedDopplerClient({
      mockSecrets: validMockSecrets,
      dopplerToken: "dp.st.mock_token"
    })

    const bootstrapConfig = client.getSourceBootstrapConfig()

    expect(bootstrapConfig.cloneToken).toBe(validMockSecrets.OTONOM_SOURCE_CLONE_TOKEN)
    expect(bootstrapConfig.repoUrl).toBe(validMockSecrets.OTONOM_SOURCE_REPO_URL)
    expect(bootstrapConfig.baseBranch).toBe("main")
    expect((bootstrapConfig as any).targetWriteToken).toBeUndefined()
  })

  it("retrieves only scoped finalizer write config", () => {
    const client = new TrustedDopplerClient({
      mockSecrets: validMockSecrets,
      dopplerToken: "dp.st.mock_token"
    })

    const finalizerConfig = client.getFinalizerConfig()

    expect(finalizerConfig.targetWriteToken).toBe(validMockSecrets.OTONOM_TARGET_WRITE_TOKEN)
    expect(finalizerConfig.committerName).toBe(validMockSecrets.OTONOM_GIT_COMMITTER_NAME)
    expect(finalizerConfig.committerEmail).toBe(validMockSecrets.OTONOM_GIT_COMMITTER_EMAIL)
    expect(finalizerConfig.baseBranch).toBe("main")
    expect((finalizerConfig as any).cloneToken).toBeUndefined()
  })

  it("never prints raw secret values in preflight summary output", () => {
    const client = new TrustedDopplerClient({
      mockSecrets: validMockSecrets,
      dopplerToken: "dp.st.mock_token"
    })

    const logs: string[] = []
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(msg)
    })

    client.logPreflightSummary({
      valid: true,
      requiredValuesPresent: 10,
      effectiveParallelism: 1,
      errors: []
    })

    consoleSpy.mockRestore()

    const combinedOutput = logs.join("\n")
    expect(combinedOutput).toContain("doppler_preflight: PASS")
    expect(combinedOutput).toContain("required_values_present: 10")
    expect(combinedOutput).toContain("effective_parallelism: 1")
    expect(combinedOutput).not.toContain(validMockSecrets.OTONOM_SOURCE_CLONE_TOKEN)
    expect(combinedOutput).not.toContain(validMockSecrets.OTONOM_TARGET_WRITE_TOKEN)
    expect(combinedOutput).not.toContain(validMockSecrets.OPENCODE_API_KEY)
  })
})
