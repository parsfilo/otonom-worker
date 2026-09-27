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

  const capabilityManager = new CapabilityRuntimeManager()

  // 1. Write task.json strictly in controlDir (outside target repo)
  fs.mkdirSync(controlDir, { recursive: true })
  const taskFilePath = path.join(controlDir, "task.json")
  fs.writeFileSync(taskFilePath, JSON.stringify(currentTask, null, 2))
  console.log(`[Prepare Lane] Wrote lane contract to: ${taskFilePath}`)

  // 2. Generate role-based OpenCode & MCP configuration outside target Git
  const opencodeConfigDir = path.join(controlDir, "opencode")
  const opencodeConfigPath = path.join(opencodeConfigDir, "opencode.json")
  const profile = capabilityManager.getProfile((currentTask as any).role)
  const serenaRuntime = profile.serena
    ? capabilityManager.prepareSerenaHome(controlDir)
    : undefined
  const pluginPath = capabilityManager.copyHarnessPlugin(opencodeConfigDir)
  capabilityManager.writeLaneConfig(
    (currentTask as any).role,
    targetWorkspace,
    opencodeConfigPath,
    { serenaHomeDir: serenaRuntime?.homeDir }
  )
  console.log(`[Prepare Lane] Configured role capabilities (${(currentTask as any).role}) at: ${opencodeConfigPath}`)
  console.log(`[Prepare Lane] Copied harness plugin to: ${pluginPath}`)
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
