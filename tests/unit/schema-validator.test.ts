import { describe, it, expect } from "vitest"
import { validateTask, validateResult, validateFinding, validateCrossLaneRequest } from "../../harness/validation/schema-validator.js"

describe("Schema Validator", () => {
  it("validates a valid task manifest", () => {
    const validTask = {
      id: "webhook-durability",
      title: "Implement idempotent webhook durability",
      role: "builder-core",
      source_repository: "oaslananka/otonom",
      base_ref: "main",
      base_sha: "0123456789abcdef0123456789abcdef01234567",
      objectives: ["Add webhook replay log", "Enforce idempotency key check"],
      allowed_write_paths: ["src/webhooks/**", "tests/webhooks/**"],
      forbidden_write_paths: ["config/secrets.yaml"],
      acceptance_criteria: ["All webhook tests pass", "Zero dropped events"],
      verification_profile: "lane",
      risk_classification: "MEDIUM",
      timeout_minutes: 20
    }

    const res = validateTask(validTask)
    expect(res.valid).toBe(true)
    expect(res.errors).toBeUndefined()
  })

  it("rejects task with invalid SHA or role", () => {
    const invalidTask = {
      id: "webhook-durability",
      title: "Bad task",
      role: "god-mode-agent", // invalid
      source_repository: "oaslananka/otonom",
      base_sha: "short-sha", // invalid
      objectives: ["do something"],
      allowed_write_paths: ["src/**"],
      acceptance_criteria: ["must work"],
      verification_profile: "lane",
      risk_classification: "LOW"
    }

    const res = validateTask(invalidTask)
    expect(res.valid).toBe(false)
    expect(res.errors).toBeDefined()
    expect(res.errors?.length).toBeGreaterThan(0)
  })

  it("validates a valid result.json", () => {
    const validResult = {
      task_id: "webhook-durability",
      lane: "webhook-durability",
      base_sha: "0123456789abcdef0123456789abcdef01234567",
      status: "PASS",
      model_used: "free-model-zen-flash",
      changed_paths: ["src/webhooks/replay.ts"],
      verification_results: [
        {
          profile: "lane",
          command: "pnpm test:webhooks",
          exit_code: 0,
          passed: true,
          duration_ms: 1200
        }
      ],
      test_summary: {
        total: 10,
        passed: 10,
        failed: 0,
        skipped: 0
      },
      policy_violations: [],
      findings_fixed: ["find-1001"],
      remaining_blockers: [],
      cross_lane_request_count: 0,
      loop_metrics: {
        tool_repeats: 0,
        file_rereads: 1,
        stall_warnings: 0,
        diff_hash_changes: 2
      },
      completed_at: new Date().toISOString()
    }

    const res = validateResult(validResult)
    expect(res.valid).toBe(true)
  })

  it("rejects invalid result with negative counts or bad status", () => {
    const invalidResult = {
      task_id: "webhook-durability",
      lane: "webhook-durability",
      base_sha: "0123456789abcdef0123456789abcdef01234567",
      status: "UNKNOWN_STATUS", // invalid
      model_used: "free-model-zen-flash",
      changed_paths: ["src/webhooks/replay.ts"],
      verification_results: [],
      test_summary: {
        total: 10,
        passed: -5, // invalid
        failed: 0,
        skipped: 0
      },
      policy_violations: [],
      findings_fixed: [],
      remaining_blockers: [],
      cross_lane_request_count: -1, // invalid
      loop_metrics: {
        tool_repeats: 0,
        file_rereads: 0,
        stall_warnings: 0,
        diff_hash_changes: 0
      },
      completed_at: "not-a-date"
    }

    const res = validateResult(invalidResult)
    expect(res.valid).toBe(false)
  })

  it("validates finding schema", () => {
    const validFinding = {
      id: "find-auth-01",
      severity: "HIGH",
      path: "src/auth/jwt.ts",
      summary: "Missing expiry validation on token",
      evidence: "jwt.verify called without verifyOptions.expiresIn",
      status: "open"
    }

    expect(validateFinding(validFinding).valid).toBe(true)

    const invalidFinding = {
      id: "bad-id", // invalid pattern
      severity: "SUPER_CRITICAL", // invalid enum
      path: "src/auth/jwt.ts",
      summary: "bad", // too short
      evidence: "bad", // too short
      status: "active" // invalid enum
    }

    expect(validateFinding(invalidFinding).valid).toBe(false)
  })

  it("validates cross-lane request schema", () => {
    const validRequest = {
      id: "clr-db-schema-01",
      requesting_lane: "webhook-durability",
      target_lane: "db-migrations",
      requested_path: "prisma/schema.prisma",
      justification: "Needs idempotency key column on WebhookLog table",
      proposed_change_description: "Add idempotency_key String @unique to WebhookLog model",
      status: "pending",
      created_at: new Date().toISOString()
    }

    expect(validateCrossLaneRequest(validRequest).valid).toBe(true)
  })
})
