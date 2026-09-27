import fs from "node:fs"
import path from "node:path"
import { containsSensitiveData } from "../logging/sanitizer.js"
import { FORBIDDEN_GIT_CONFIG_PATTERNS } from "./secret-boundary.js"

export interface ConfidentialityCheckResult {
  valid: boolean
  sentinelFoundInPrivateLog: boolean
  secretPatternsFoundInArtifacts: number
  gitConfigClean: boolean
  errors: string[]
}

export function runConfidentialityCheck(
  controlDir: string,
  privateDir: string,
  targetWorkspaceDir?: string
): ConfidentialityCheckResult {
  const errors: string[] = []
  let sentinelFound = false
  let secretPatternsFound = 0
  let gitConfigClean = true

  // 1. Confirm sentinel exists strictly in private directory
  const sentinelFile = path.join(privateDir, "sentinel.log")
  if (fs.existsSync(sentinelFile)) {
    const sentinelContent = fs.readFileSync(sentinelFile, "utf-8")
    if (sentinelContent.includes("PRIVATE_LOG_SENTINEL_PHASE2")) {
      sentinelFound = true
    } else {
      errors.push("Sentinel marker not found in private sentinel.log")
    }
  } else {
    errors.push(`Private sentinel file missing at: ${sentinelFile}`)
  }

  // 2. Scan all control and manifest files for secret leaks
  const controlFiles = ["task.json", "result.json", "finalizer-report.json"]
  for (const file of controlFiles) {
    const filePath = path.join(controlDir, file)
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8")
      if (containsSensitiveData(content)) {
        secretPatternsFound++
        errors.push(`Sensitive token pattern detected in ${file}`)
      }
    }
  }

  // 3. Scan target workspace .git/config
  if (targetWorkspaceDir) {
    const gitConfigFile = path.join(targetWorkspaceDir, ".git", "config")
    if (fs.existsSync(gitConfigFile)) {
      const configContent = fs.readFileSync(gitConfigFile, "utf-8")
      for (const pattern of FORBIDDEN_GIT_CONFIG_PATTERNS) {
        if (pattern.test(configContent)) {
          gitConfigClean = false
          secretPatternsFound++
          errors.push("Forbidden credential pattern detected in target .git/config")
          break
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    sentinelFoundInPrivateLog: sentinelFound,
    secretPatternsFoundInArtifacts: secretPatternsFound,
    gitConfigClean,
    errors
  }
}

export function main() {
  const controlDir = process.argv[2] || process.env.CONTROL_DIR || "."
  const privateDir = process.argv[3] || process.env.PRIVATE_DIR || "./private"
  const targetWorkspace = process.argv[4] || process.env.TARGET_WORKSPACE

  const result = runConfidentialityCheck(controlDir, privateDir, targetWorkspace)

  if (result.valid) {
    console.log("confidentiality_boundaries: PASS")
    console.log("private_sentinel_verified: PASS")
    console.log("secret_absence_verified: PASS")
    process.exit(0)
  } else {
    console.error("confidentiality_boundaries: FAIL")
    for (const err of result.errors) {
      console.error(`  - ${err}`)
    }
    process.exit(1)
  }
}

if (process.argv[1] && process.argv[1].endsWith("confidentiality-check.ts")) {
  main()
}
