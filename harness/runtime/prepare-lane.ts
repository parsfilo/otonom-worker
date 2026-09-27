import fs from "node:fs"
import path from "node:path"
import { loadManifestFile } from "../matrix/generator.js"
import { CapabilityRuntimeManager } from "./capability-runtime.js"

export function prepareLane(
  manifestPath: string,
  laneId: string,
  controlDir: string,
  targetWorkspace: string
) {
  if (!manifestPath || !laneId) {
    throw new Error("prepareLane requires manifestPath and laneId")
  }

  const tasks = loadManifestFile(manifestPath)
  const currentTask = tasks.find((t: any) => t.id === laneId)
  if (!currentTask) {
    throw new Error(`Task with ID '${laneId}' not found in manifest: ${manifestPath}`)
  }

  // 1. Write task.json strictly in controlDir (outside target repo)
  fs.mkdirSync(controlDir, { recursive: true })
  const taskFilePath = path.join(controlDir, "task.json")
  fs.writeFileSync(taskFilePath, JSON.stringify(currentTask, null, 2))
  console.log(`[Prepare Lane] Wrote lane contract to: ${taskFilePath}`)

  // 2. Generate role-based OpenCode & MCP configuration for the lane
  const capabilityManager = new CapabilityRuntimeManager()
  const opencodeConfigPath = path.join(targetWorkspace, ".opencode/opencode.json")
  capabilityManager.writeLaneConfig((currentTask as any).role, targetWorkspace, opencodeConfigPath)
  console.log(`[Prepare Lane] Configured role capabilities (${(currentTask as any).role}) at: ${opencodeConfigPath}`)
}

if (process.argv[1] && process.argv[1].endsWith("prepare-lane.ts")) {
  const manifestPath = process.argv[2] || process.env.MANIFEST_PATH || "config/lanes.example.yaml"
  const laneId = process.argv[3] || process.env.LANE_ID || ""
  const controlDir = process.argv[4] || process.env.CONTROL_DIR || "."
  const targetWorkspace = process.argv[5] || process.env.TARGET_WORKSPACE || "."

  try {
    prepareLane(manifestPath, laneId, controlDir, targetWorkspace)
  } catch (err: any) {
    console.error(`[Prepare Lane Fatal] ${err.message}`)
    process.exit(1)
  }
}
