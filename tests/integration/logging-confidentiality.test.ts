import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { AgentRunner } from "../../harness/runtime/agent-runner.js"

describe("Logging Confidentiality & Execution Supervision", () => {
  let tempDir: string
  let privateDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-test-"))
    privateDir = path.join(tempDir, "otonom-private", "lane-test")
    fs.mkdirSync(privateDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it("Test A: fake private TypeScript source emitted by agent never enters public stdout", async () => {
    // Fake agent script emitting proprietary source code
    const fakeAgentScript = path.join(tempDir, "fake-agent-source.js")
    const proprietaryCode = `
      // PROPRIETARY OTONOM ALGORITHM
      export function secretArbitrageStrategy(x: number): number {
        return x * 42.1337;
      }
    `
    fs.writeFileSync(
      fakeAgentScript,
      `console.log(${JSON.stringify(proprietaryCode)});\nprocess.exit(0);`
    )

    const interceptedPublicLogs: string[] = []
    const runner = new AgentRunner({
      laneId: "lane-test",
      privateDir,
      command: process.execPath,
      args: [fakeAgentScript],
      onPublicLog: (msg) => interceptedPublicLogs.push(msg)
    })

    const result = await runner.run()

    expect(result.exitCode).toBe(0)
    expect(result.status).toBe("PASS")

    // Private log file has the content
    const stdoutContent = fs.readFileSync(result.stdoutPath, "utf-8")
    expect(stdoutContent).toContain("secretArbitrageStrategy")

    // Public logs MUST NEVER contain the proprietary code or function name
    const allPublicOutput = interceptedPublicLogs.join("\n")
    expect(allPublicOutput).not.toContain("secretArbitrageStrategy")
    expect(allPublicOutput).not.toContain("PROPRIETARY")
    expect(allPublicOutput).not.toContain("42.1337")
  })

  it("Test B: fake PAT / token emitted by agent never appears in public logs", async () => {
    const fakeAgentScript = path.join(tempDir, "fake-agent-token.js")
    const fakeSecret = "ghp_FakeGitHubPatTokenForConfidentialityTesting12345"
    fs.writeFileSync(
      fakeAgentScript,
      `console.log("Token leaked: " + ${JSON.stringify(fakeSecret)});\nprocess.exit(0);`
    )

    const interceptedPublicLogs: string[] = []
    const runner = new AgentRunner({
      laneId: "lane-test",
      privateDir,
      command: process.execPath,
      args: [fakeAgentScript],
      onPublicLog: (msg) => interceptedPublicLogs.push(msg)
    })

    const result = await runner.run()
    expect(result.status).toBe("PASS")

    const stdoutContent = fs.readFileSync(result.stdoutPath, "utf-8")
    expect(stdoutContent).toContain(fakeSecret)

    const allPublicOutput = interceptedPublicLogs.join("\n")
    expect(allPublicOutput).not.toContain(fakeSecret)
  })

  it("Test C: fake stack trace with source lines never appears in public logs", async () => {
    const fakeAgentScript = path.join(tempDir, "fake-agent-trace.js")
    const stackSnippet = "at calculateInternalYield (/home/runner/work/otonom/src/yield/core.ts:42:15)"
    fs.writeFileSync(
      fakeAgentScript,
      `console.error("Error: database connection crash\\n    ${stackSnippet}");\nprocess.exit(1);`
    )

    const interceptedPublicLogs: string[] = []
    const runner = new AgentRunner({
      laneId: "lane-test",
      privateDir,
      command: process.execPath,
      args: [fakeAgentScript],
      onPublicLog: (msg) => interceptedPublicLogs.push(msg)
    })

    const result = await runner.run()
    expect(result.exitCode).toBe(1)
    expect(result.status).toBe("FAIL")

    const stderrContent = fs.readFileSync(result.stderrPath, "utf-8")
    expect(stderrContent).toContain("calculateInternalYield")

    const allPublicOutput = interceptedPublicLogs.join("\n")
    expect(allPublicOutput).not.toContain("calculateInternalYield")
    expect(allPublicOutput).not.toContain("/src/yield/core.ts")
  })

  it("Test D: OpenCode non-zero exit can be classified without exposing stderr", async () => {
    const fakeAgentScript = path.join(tempDir, "fake-agent-rate-limit.js")
    fs.writeFileSync(
      fakeAgentScript,
      `console.error("RateLimitError: 429 Too Many Requests: quota exceeded for model zen/gemini-2.5-flash");\nprocess.exit(42);`
    )

    const interceptedPublicLogs: string[] = []
    const runner = new AgentRunner({
      laneId: "lane-test",
      privateDir,
      command: process.execPath,
      args: [fakeAgentScript],
      onPublicLog: (msg) => interceptedPublicLogs.push(msg)
    })

    const result = await runner.run()
    expect(result.exitCode).toBe(42)
    expect(result.status).toBe("RATE_LIMITED")

    const allPublicOutput = interceptedPublicLogs.join("\n")
    expect(allPublicOutput).not.toContain("zen/gemini-2.5-flash")
    expect(allPublicOutput).not.toContain("quota exceeded")
    expect(allPublicOutput).toContain("RATE_LIMITED")
  })

  it("Test E: STALLED output remains private and process is terminated safely", async () => {
    const fakeAgentScript = path.join(tempDir, "fake-agent-stall.js")
    // Hangs forever while printing sensitive info periodically
    fs.writeFileSync(
      fakeAgentScript,
      `
      console.log("INTERNAL AGENT DATA DUMP");
      setInterval(() => {
        console.log("SECRET HEARTBEAT 12345");
      }, 100);
      `
    )

    const interceptedPublicLogs: string[] = []
    const runner = new AgentRunner({
      laneId: "lane-test",
      privateDir,
      command: process.execPath,
      args: [fakeAgentScript],
      timeoutMs: 800, // Short timeout for test
      onPublicLog: (msg) => interceptedPublicLogs.push(msg)
    })

    const result = await runner.run()
    expect(result.stalled || result.timedOut).toBe(true)
    expect(result.status).toBe("STALLED")

    const allPublicOutput = interceptedPublicLogs.join("\n")
    expect(allPublicOutput).not.toContain("INTERNAL AGENT DATA DUMP")
    expect(allPublicOutput).not.toContain("SECRET HEARTBEAT 12345")
  })
})
