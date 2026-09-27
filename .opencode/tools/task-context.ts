import fs from "node:fs"

export class TaskContextTool {
  constructor(private taskPath: string) {}

  public async execute(): Promise<Record<string, unknown>> {
    if (!fs.existsSync(this.taskPath)) {
      throw new Error(`Task contract not found at: ${this.taskPath}`)
    }

    const raw = fs.readFileSync(this.taskPath, "utf-8")
    const parsed = JSON.parse(raw)

    return {
      id: parsed.id,
      title: parsed.title,
      role: parsed.role,
      source_repository: parsed.source_repository,
      base_ref: parsed.base_ref,
      base_sha: parsed.base_sha,
      objectives: parsed.objectives,
      allowed_write_paths: parsed.allowed_write_paths,
      forbidden_write_paths: parsed.forbidden_write_paths || [],
      acceptance_criteria: parsed.acceptance_criteria,
      verification_profile: parsed.verification_profile,
      timeout_minutes: parsed.timeout_minutes,
      risk_classification: parsed.risk_classification,
      requires_changes: parsed.requires_changes === true
    }
  }
}
