import fs from "node:fs"
import { formatPublicSummary } from "../logging/sanitizer.js"

export function emitSanitizedSummary(reportPath: string, laneId: string) {
  let status: any = "FAIL"
  let filesChanged = 0
  let testsPassed = 0
  let testsFailed = 1
  let policyViolations = 0

  if (fs.existsSync(reportPath)) {
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"))
      status = report.success ? "PASS" : "FAIL"
      filesChanged = report.authoritativeChangedPaths?.length || 0
      if (report.trustedVerification) {
        testsPassed = report.trustedVerification.passed ? 1 : 0
        testsFailed = report.trustedVerification.passed ? 0 : 1
      }
    } catch {
      status = "FAIL"
    }
  }

  console.log(
    formatPublicSummary({
      lane: laneId,
      status,
      filesChanged,
      testsPassed,
      testsFailed,
      policyViolations
    })
  )
}

if (process.argv[1] && process.argv[1].endsWith("emit-summary.ts")) {
  const reportPath = process.argv[2] || process.env.REPORT_PATH || "finalizer-report.json"
  const laneId = process.argv[3] || process.env.LANE_ID || "unknown"

  emitSanitizedSummary(reportPath, laneId)
}
