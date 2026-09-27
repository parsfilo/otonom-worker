import { Finalizer } from "./finalizer.js"
import { TrustedDopplerClient } from "../doppler/client.js"

async function main() {
  const taskPath = process.argv[2] || process.env.TASK_PATH || "task.json"
  const resultPath = process.argv[3] || process.env.RESULT_PATH || "result.json"
  const workspaceRoot = process.argv[4] || process.cwd()
  const reportOutputPath = process.argv[5] || process.env.REPORT_PATH
  const dryRun = process.env.DRY_RUN !== "false"
  const workflowRunId = process.env.GITHUB_RUN_ID || "local-test"
  const targetToken = process.env.TARGET_WRITE_TOKEN || process.env.OTONOM_TARGET_WRITE_TOKEN
  const committerName = process.env.OTONOM_GIT_COMMITTER_NAME
  const committerEmail = process.env.OTONOM_GIT_COMMITTER_EMAIL
  const dopplerClient = process.env.DOPPLER_TOKEN ? new TrustedDopplerClient() : undefined
  const createPr = process.env.CREATE_PR === "true" || (!dryRun && Boolean(targetToken || dopplerClient))

  console.log(`[Finalizer] Starting validation...`)
  console.log(`  Task: ${taskPath}`)
  console.log(`  Result: ${resultPath}`)
  console.log(`  Dry Run: ${dryRun}`)
  console.log(`  Run ID: ${workflowRunId}`)
  console.log(`  Create PR: ${createPr}`)

  try {
    const finalizer = new Finalizer({
      taskPath,
      resultPath,
      workspaceRoot,
      dryRun,
      workflowRunId,
      targetToken,
      reportOutputPath,
      committerName,
      committerEmail,
      createPr,
      dopplerClient
    })

    const report = await finalizer.execute()
    if (!report.success) {
      console.error(`[Finalizer Error] ${report.error}`)
      process.exit(1)
    }

    console.log(`[Finalizer Success] Status: VALID`)
    console.log(`  Branch: ${report.branchName}`)
    console.log(`  Dry Run: ${report.dryRun}`)
    console.log(`  Pushed: ${report.pushed}`)
    if (report.prUrl) {
      console.log(`  PR URL: ${report.prUrl}`)
    }
    process.exit(0)
  } catch (err: any) {
    console.error(`[Finalizer Fatal] ${err.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && process.argv[1].endsWith("cli.ts")) {
  main()
}
