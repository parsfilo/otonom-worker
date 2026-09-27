import fs from "node:fs"
import path from "node:path"
import { validateFinding } from "../../harness/validation/schema-validator.js"

export interface FindingInput {
  id: string
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
  path: string
  line_range?: { start: number; end: number }
  summary: string
  evidence: string
  rule_id?: string
  status: "open" | "fixed" | "suppressed" | "wontfix"
}

export class RecordFindingTool {
  constructor(private privateDir: string) {}

  public async execute(finding: FindingInput): Promise<{ success: boolean; error?: string }> {
    const val = validateFinding(finding)
    if (!val.valid) {
      return { success: false, error: `Invalid finding schema: ${val.errors?.join("; ")}` }
    }

    const findingsFile = path.join(this.privateDir, "findings.json")
    let findings: FindingInput[] = []

    if (fs.existsSync(findingsFile)) {
      try {
        findings = JSON.parse(fs.readFileSync(findingsFile, "utf-8"))
      } catch {
        findings = []
      }
    }

    findings.push(finding)
    fs.writeFileSync(findingsFile, JSON.stringify(findings, null, 2), "utf-8")

    return { success: true }
  }
}
