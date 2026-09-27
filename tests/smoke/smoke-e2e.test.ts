import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { RunVerificationTool } from "../../.opencode/tools/run-verification.js"
import { CompleteLaneTool } from "../../.opencode/tools/complete-lane.js"
import { Finalizer } from "../../harness/finalizer/finalizer.js"
import { sanitizeEnv } from "../../harness/policies/env-policy.js"
import { validateResult } from "../../harness/validation/schema-validator.js"

describe("End-to-End Harness Smoke Test", () => {
  let fixtureDir: string
  let privateDir: string
  let taskPath: string

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-smoke-"))
    privateDir = path.join(fixtureDir, "private-storage")
    fs.mkdirSync(privateDir, { recursive: true })
    fs.mkdirSync(path.join(fixtureDir, "src"), { recursive: true })
    fs.mkdirSync(path.join(fixtureDir, "tests"), { recursive: true })

    // Initialize git repository
    execFileSync("git", ["init"], { cwd: fixtureDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: fixtureDir, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: fixtureDir, stdio: "ignore" })

    // Initial base commit
    fs.writeFileSync(path.join(fixtureDir, "README.md"), "# Smoke Test Fixture\n")
    execFileSync("git", ["add", "."], { cwd: fixtureDir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "initial base commit"], { cwd: fixtureDir, stdio: "ignore" })
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixtureDir, encoding: "utf-8" }).trim()

    // Create fixture source and test
    fs.writeFileSync(
      path.join(fixtureDir, "src", "math.js"),
      `export function add(a, b) { return a + b; }`
    )

    fs.writeFileSync(
      path.join(fixtureDir, "tests", "math.test.mjs"),
      `import assert from "node:assert";
import { add } from "../src/math.js";
assert.strictEqual(add(2, 3), 5);
console.log("SMOKE TEST PASSED");`
    )

    // Create fixture task contract
    const taskManifest = {
      id: "smoke-lane-math",
      title: "Add pure math utility",
      role: "builder-core",
      source_repository: "oaslananka/otonom",
      base_ref: "main",
      base_sha: baseSha,
      objectives: ["Add add(a, b) function", "Verify test passes"],
      allowed_write_paths: ["src/math.js", "tests/math.test.mjs"],
      acceptance_criteria: ["Math unit test exits with code 0"],
      verification_profile: "lane",
      risk_classification: "LOW"
    }

    taskPath = path.join(fixtureDir, "task.json")
    fs.writeFileSync(taskPath, JSON.stringify(taskManifest, null, 2))
  })

  afterEach(() => {
    try {
      fs.rmSync(fixtureDir, { recursive: true, force: true })
    } catch {}
  })

  it("executes the entire harness flow against fixture repo and passes finalizer dry-run", async () => {
    // 1. Verify environment secret stripping
    const pollutedEnv = {
      ...process.env,
      DOPPLER_TOKEN: "dp.st.test_secret",
      GITHUB_TOKEN: "ghp_secret"
    }
    const safeEnv = sanitizeEnv(pollutedEnv)
    expect(safeEnv.DOPPLER_TOKEN).toBeUndefined()
    expect(safeEnv.GITHUB_TOKEN).toBeUndefined()
    expect(safeEnv.CI).toBe("1")

    // 2. Execute verification via harness verification runner tool
    const verifTool = new RunVerificationTool({
      customProfiles: {
        lane: `node tests/math.test.mjs`
      },
      cwd: fixtureDir
    })

    const verifResult = await verifTool.execute({ profile: "lane" })
    expect(verifResult.passed).toBe(true)
    expect(verifResult.exit_code).toBe(0)

    // 3. Invoke complete_lane tool with verified changes
    const completeTool = new CompleteLaneTool({
      taskPath,
      privateDir,
      workspaceRoot: fixtureDir,
      latestVerification: verifResult,
      changedPaths: ["src/math.js", "tests/math.test.mjs"],
      modelUsed: "zen:gemini-2.5-flash"
    })

    const completionResult = await completeTool.execute()
    expect(completionResult.completed).toBe(true)
    expect(completionResult.resultPath).toBeDefined()

    // 4. Verify result.json complies with schema
    const resultJson = JSON.parse(fs.readFileSync(completionResult.resultPath!, "utf-8"))
    expect(validateResult(resultJson).valid).toBe(true)
    expect(resultJson.task_id).toBe("smoke-lane-math")
    expect(resultJson.status).toBe("PASS")

    // 5. Run Trusted Finalizer in dry-run mode
    const finalizer = new Finalizer({
      taskPath,
      resultPath: completionResult.resultPath!,
      workspaceRoot: fixtureDir,
      dryRun: true,
      workflowRunId: "smoke-run-42",
      customVerificationProfiles: {
        lane: "node tests/math.test.mjs"
      }
    })

    const report = await finalizer.execute()
    expect(report.success).toBe(true)
    expect(report.dryRun).toBe(true)
    expect(report.pushed).toBe(false)
    expect(report.branchName).toBe("swarm/smoke-run-42/smoke-lane-math")

    // 6. Verify PR Body contains only sanitized metadata
    const taskData = JSON.parse(fs.readFileSync(taskPath, "utf-8"))
    const prBody = Finalizer.formatPrBody(taskData, resultJson)
    expect(prBody).toContain("## Swarm Lane Execution: smoke-lane-math")
    expect(prBody).not.toContain("diff --git")
    expect(prBody).not.toContain("secret")
  })
})
