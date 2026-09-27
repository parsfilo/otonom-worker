import fs from "node:fs"
import path from "node:path"
import { validateCrossLaneRequest } from "../../harness/validation/schema-validator.js"

export interface CrossLaneInput {
  id: string
  target_lane: string
  requested_path: string
  justification: string
  proposed_change_description: string
}

export class CrossLaneRequestTool {
  constructor(private privateDir: string, private requestingLane: string) {}

  public async execute(input: CrossLaneInput): Promise<{ success: boolean; error?: string }> {
    const payload = {
      ...input,
      requesting_lane: this.requestingLane,
      status: "pending",
      created_at: new Date().toISOString()
    }

    const val = validateCrossLaneRequest(payload)
    if (!val.valid) {
      return { success: false, error: `Invalid cross-lane request: ${val.errors?.join("; ")}` }
    }

    const reqFile = path.join(this.privateDir, "cross-lane-requests.json")
    let requests: any[] = []

    if (fs.existsSync(reqFile)) {
      try {
        requests = JSON.parse(fs.readFileSync(reqFile, "utf-8"))
      } catch {
        requests = []
      }
    }

    requests.push(payload)
    fs.writeFileSync(reqFile, JSON.stringify(requests, null, 2), "utf-8")

    return { success: true }
  }
}
