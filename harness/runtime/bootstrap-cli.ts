import fs from "node:fs"
import path from "node:path"
import { TrustedDopplerClient } from "../doppler/client.js"
import { SourceBootstrapper } from "./source-bootstrap.js"

export async function bootstrapTargetWorkspace(taskPath: string, targetWorkspaceDir: string): Promise<string> {
  if (!fs.existsSync(taskPath)) {
    throw new Error(`Task file not found: ${taskPath}`)
  }

  const task = JSON.parse(fs.readFileSync(taskPath, "utf-8"))
  const client = new TrustedDopplerClient()
  const bootstrapConfig = client.getSourceBootstrapConfig()

  const bootstrapper = new SourceBootstrapper({
    repoUrl: bootstrapConfig.repoUrl,
    cloneToken: bootstrapConfig.cloneToken,
    targetSha: task.base_sha,
    baseBranch: bootstrapConfig.baseBranch || task.base_ref || "main",
    destinationDir: targetWorkspaceDir
  })

  const result = await bootstrapper.bootstrap()
  if (!result.success) {
    throw new Error(`Source bootstrap failed: ${result.error}`)
  }

  // Update task contract with the exact checked out commit SHA
  task.base_sha = result.checkedOutSha
  fs.writeFileSync(taskPath, JSON.stringify(task, null, 2))
  console.log(`[Bootstrap] Updated task base_sha to: ${result.checkedOutSha}`)

  return result.checkedOutSha
}

if (process.argv[1] && process.argv[1].endsWith("bootstrap-cli.ts")) {
  const taskPath = process.argv[2] || process.env.TASK_PATH || "task.json"
  const targetWorkspace = process.argv[3] || process.env.TARGET_WORKSPACE || "."

  bootstrapTargetWorkspace(taskPath, targetWorkspace)
    .then((sha) => {
      console.log(`[Bootstrap Success] Target SHA: ${sha}`)
      process.exit(0)
    })
    .catch((err) => {
      console.error(`[Bootstrap Fatal] ${err.message}`)
      process.exit(1)
    })
}
