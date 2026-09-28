import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { assertAgentSecretBoundary } from "../../harness/policies/secret-boundary.js"

describe("Agent Secret Boundary Assertion", () => {
  let tempDir: string
  let gitConfigFile: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boundary-test-"))
    const gitDir = path.join(tempDir, ".git")
    fs.mkdirSync(gitDir, { recursive: true })
    gitConfigFile = path.join(gitDir, "config")
    fs.writeFileSync(
      gitConfigFile,
      `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\thooksPath = /dev/null\n`
    )
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it("passes when clean environment and clean .git/config are provided", () => {
    const cleanEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CI: "1",
      LANE_ID: "phase2-smoke"
    }

    const logs: string[] = []
    const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(msg)
    })

    expect(() => assertAgentSecretBoundary(cleanEnv, tempDir)).not.toThrow()
    spy.mockRestore()

    expect(logs).toContain("agent_secret_boundary: PASS")
  })

  it("fails closed when DOPPLER_TOKEN is in agent environment", () => {
    const taintedEnv = {
      PATH: "/usr/bin",
      DOPPLER_TOKEN: "dp.st.secret_123"
    }

    expect(() => assertAgentSecretBoundary(taintedEnv, tempDir)).toThrow(
      /Security boundary violation.*DOPPLER_TOKEN/i
    )
  })

  it("fails closed when OTONOM_SOURCE_CLONE_TOKEN is in agent environment", () => {
    const taintedEnv = {
      PATH: "/usr/bin",
      OTONOM_SOURCE_CLONE_TOKEN: "ghp_source123"
    }

    expect(() => assertAgentSecretBoundary(taintedEnv, tempDir)).toThrow(
      /Security boundary violation.*OTONOM_SOURCE_CLONE_TOKEN/i
    )
  })

  it("fails closed when OTONOM_TARGET_WRITE_TOKEN is in agent environment", () => {
    const taintedEnv = {
      PATH: "/usr/bin",
      OTONOM_TARGET_WRITE_TOKEN: "ghp_target123"
    }

    expect(() => assertAgentSecretBoundary(taintedEnv, tempDir)).toThrow(
      /Security boundary violation.*OTONOM_TARGET_WRITE_TOKEN/i
    )
  })

  it("fails closed when GITHUB_TOKEN is in agent environment", () => {
    const taintedEnv = {
      PATH: "/usr/bin",
      GITHUB_TOKEN: "ghs_random"
    }

    expect(() => assertAgentSecretBoundary(taintedEnv, tempDir)).toThrow(
      /Security boundary violation.*GITHUB_TOKEN/i
    )
  })

  it("fails closed when ACTIONS_ID_TOKEN_REQUEST_TOKEN is in agent environment", () => {
    const taintedEnv = {
      PATH: "/usr/bin",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "actions_oidc_token"
    }

    expect(() => assertAgentSecretBoundary(taintedEnv, tempDir)).toThrow(
      /Security boundary violation.*ACTIONS_ID_TOKEN_REQUEST_TOKEN/i
    )
  })

  it("fails closed when target .git/config contains a github_pat_ token", () => {
    fs.appendFileSync(gitConfigFile, `[remote "origin"]\n\turl = https://github_pat_11AAAAAA@github.com/repo.git\n`)

    const cleanEnv = { PATH: "/usr/bin" }
    expect(() => assertAgentSecretBoundary(cleanEnv, tempDir)).toThrow(
      /Security boundary violation: target \.git\/config contains forbidden credential pattern/i
    )
  })

  it("fails closed when target .git/config contains an x-access-token credential", () => {
    fs.appendFileSync(gitConfigFile, `[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46dG9rZW4=\n`)

    const cleanEnv = { PATH: "/usr/bin" }
    expect(() => assertAgentSecretBoundary(cleanEnv, tempDir)).toThrow(
      /Security boundary violation: target \.git\/config contains forbidden credential pattern/i
    )
  })

  it("fails closed when target .git/config contains bearer credential", () => {
    fs.appendFileSync(gitConfigFile, `[http]\n\textraHeader = Authorization: Bearer secret_token\n`)

    const cleanEnv = { PATH: "/usr/bin" }
    expect(() => assertAgentSecretBoundary(cleanEnv, tempDir)).toThrow(
      /Security boundary violation: target \.git\/config contains forbidden credential pattern/i
    )
  })
})
