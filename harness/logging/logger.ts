import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { sanitizePublicLog, formatPublicSummary, PublicSummaryMetrics } from "./sanitizer.js"

export interface LoggerOptions {
  lane: string
  runnerTemp?: string
}

export class HarnessLogger {
  private lane: string
  private privateLogDir: string
  private telemetryFile: string
  private diagnosticsFile: string

  constructor(options: LoggerOptions) {
    this.lane = options.lane
    const baseTemp = options.runnerTemp || process.env.RUNNER_TEMP || path.join(os.tmpdir(), "runner-temp")
    this.privateLogDir = path.join(baseTemp, "otonom-private", this.lane)

    // Ensure private storage directory exists
    fs.mkdirSync(this.privateLogDir, { recursive: true })
    this.telemetryFile = path.join(this.privateLogDir, "telemetry.jsonl")
    this.diagnosticsFile = path.join(this.privateLogDir, "diagnostics.log")
  }

  public getPrivateLogDir(): string {
    return this.privateLogDir
  }

  /**
   * Log private diagnostic details to runner local storage.
   * This NEVER goes to standard out or GitHub workflow logs.
   */
  public logPrivateDiagnostic(message: string) {
    const entry = `[${new Date().toISOString()}] ${message}\n`
    fs.appendFileSync(this.diagnosticsFile, entry, "utf-8")
  }

  /**
   * Log private structured telemetry event to runner local storage.
   */
  public logPrivateTelemetry(event: Record<string, unknown>) {
    const entry = JSON.stringify({ ...event, timestamp: new Date().toISOString() }) + "\n"
    fs.appendFileSync(this.telemetryFile, entry, "utf-8")
  }

  /**
   * Output sanitized public summary to console.
   * Guarantees bounded metadata only, no raw source or tokens.
   */
  public emitPublicSummary(metrics: PublicSummaryMetrics) {
    const summary = formatPublicSummary(metrics)
    const sanitized = sanitizePublicLog(summary)
    console.log("=== LANE EXECUTION SUMMARY ===")
    console.log(sanitized)
    console.log("==============================")
  }

  /**
   * Clean up private directory if needed.
   */
  public cleanPrivateLogs() {
    try {
      if (fs.existsSync(this.privateLogDir)) {
        fs.rmSync(this.privateLogDir, { recursive: true, force: true })
      }
    } catch {
      // Best effort cleanup
    }
  }
}
