import { describe, it, expect } from "vitest"
import { generateMatrix, MatrixGenerationInput } from "../../harness/matrix/generator.js"

describe("Matrix Generator", () => {
  const validTasks = [
    {
      id: "lane-auth",
      title: "Auth Lane",
      role: "builder-core",
      source_repository: "oaslananka/otonom",
      base_sha: "0123456789abcdef0123456789abcdef01234567",
      objectives: ["Fix auth token check"],
      allowed_write_paths: ["src/auth/**"],
      acceptance_criteria: ["Tests pass"],
      verification_profile: "lane",
      risk_classification: "MEDIUM",
      timeout_minutes: 25
    },
    {
      id: "lane-db",
      title: "DB Lane",
      role: "builder-db",
      source_repository: "oaslananka/otonom",
      base_sha: "0123456789abcdef0123456789abcdef01234567",
      objectives: ["Add index to user id"],
      allowed_write_paths: ["prisma/**"],
      acceptance_criteria: ["Migration succeeds"],
      verification_profile: "targeted",
      risk_classification: "LOW",
      timeout_minutes: 15
    }
  ]

  it("generates valid matrix for GitHub Actions", () => {
    const input: MatrixGenerationInput = {
      tasks: validTasks,
      maxParallel: 5
    }

    const output = generateMatrix(input)
    expect(output.maxParallel).toBe(5)
    expect(output.matrix.include.length).toBe(2)
    expect(output.matrix.include[0].lane).toBe("lane-auth")
    expect(output.matrix.include[0].role).toBe("builder-core")
    expect(output.matrix.include[1].lane).toBe("lane-db")
  })

  it("rejects max_parallel > 20", () => {
    const input: MatrixGenerationInput = {
      tasks: validTasks,
      maxParallel: 25
    }

    expect(() => generateMatrix(input)).toThrow(/max_parallel cannot exceed 20/)
  })

  it("rejects duplicate lane IDs", () => {
    const duplicateTasks = [
      { ...validTasks[0], id: "duplicate-lane" },
      { ...validTasks[1], id: "duplicate-lane" }
    ]

    expect(() =>
      generateMatrix({
        tasks: duplicateTasks,
        maxParallel: 5
      })
    ).toThrow(/Duplicate lane ID detected: duplicate-lane/)
  })

  it("filters lanes by lane filter when provided", () => {
    const input: MatrixGenerationInput = {
      tasks: validTasks,
      maxParallel: 5,
      laneFilter: "lane-db"
    }

    const output = generateMatrix(input)
    expect(output.matrix.include.length).toBe(1)
    expect(output.matrix.include[0].lane).toBe("lane-db")
  })

  it("rejects tasks failing schema validation", () => {
    const invalidTasks = [
      {
        id: "bad-task",
        // missing required fields: title, role, base_sha, etc.
        objectives: []
      }
    ]

    expect(() =>
      generateMatrix({
        tasks: invalidTasks as any,
        maxParallel: 5
      })
    ).toThrow(/Task schema validation failed/)
  })
})
