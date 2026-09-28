import { describe, it, expect } from "vitest"
import { buildTaskPrompt } from "../../harness/runtime/run-lane.js"

describe("Run Lane Task Completion Contract", () => {
  it("includes acceptance criteria, verification profile, and mutation semantics in the model prompt", () => {
    const prompt = buildTaskPrompt({
      id: "phase2-private-pr-smoke",
      objectives: ["Create the smoke validation document"],
      acceptance_criteria: ["Validation document exists", "No other files are modified"],
      verification_profile: "smoke-doc",
      allowed_write_paths: ["docs/swarm-smoke/phase2-harness-validation.md"]
    })

    expect(prompt).toContain("Acceptance Criteria:")
    expect(prompt).toContain("Validation document exists")
    expect(prompt).toContain("Required Verification Profile:")
    expect(prompt).toContain("smoke-doc")
    expect(prompt).toContain("textual explanation without the required repository changes is NOT completion")
    expect(prompt).toContain("call complete_lane")
    expect(prompt).toContain("Do not run dependency-mutating package-manager commands")
  })
})
