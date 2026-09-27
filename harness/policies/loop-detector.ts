/**
 * Loop & Stall Detector
 * Free models can enter repeated tool-call loops or repeat failing commands.
 * This module tracks progress and triggers warnings or clean STALLED termination.
 */

export enum LoopStatus {
  OK = "OK",
  WARNING = "WARNING",
  STALLED = "STALLED"
}

export interface LoopDetectorConfig {
  maxIdenticalToolCalls?: number
  maxFileRereads?: number
  maxFailingCommandsWithoutDiff?: number
}

export interface LoopMetrics {
  tool_repeats: number
  file_rereads: number
  stall_warnings: number
  diff_hash_changes: number
}

export class LoopDetector {
  private maxIdenticalToolCalls: number
  private maxFileRereads: number
  private maxFailingCommandsWithoutDiff: number

  private lastToolFingerprint: string | null = null
  private toolRepeatCount: number = 0
  private fileReadCounts: Map<string, number> = new Map()
  private consecutiveCommandFailures: number = 0

  private lastDiffHash: string | null = null
  private totalToolRepeats: number = 0
  private totalFileRereads: number = 0
  private totalStallWarnings: number = 0
  private totalDiffChanges: number = 0

  constructor(config: LoopDetectorConfig = {}) {
    this.maxIdenticalToolCalls = config.maxIdenticalToolCalls ?? 3
    this.maxFileRereads = config.maxFileRereads ?? 4
    this.maxFailingCommandsWithoutDiff = config.maxFailingCommandsWithoutDiff ?? 3
  }

  private fingerprint(tool: string, args: unknown): string {
    return `${tool}:${JSON.stringify(args || {})}`
  }

  public recordToolCall(tool: string, args: unknown): LoopStatus {
    const fp = this.fingerprint(tool, args)

    if (this.lastToolFingerprint === fp) {
      this.toolRepeatCount++
      this.totalToolRepeats++
    } else {
      this.lastToolFingerprint = fp
      this.toolRepeatCount = 1
    }

    if (this.toolRepeatCount > this.maxIdenticalToolCalls) {
      return LoopStatus.STALLED
    }
    if (this.toolRepeatCount === this.maxIdenticalToolCalls) {
      this.totalStallWarnings++
      return LoopStatus.WARNING
    }

    return LoopStatus.OK
  }

  public recordFileRead(filePath: string): LoopStatus {
    const count = (this.fileReadCounts.get(filePath) || 0) + 1
    this.fileReadCounts.set(filePath, count)

    if (count > 1) {
      this.totalFileRereads++
    }

    if (count > this.maxFileRereads) {
      return LoopStatus.STALLED
    }
    if (count === this.maxFileRereads) {
      this.totalStallWarnings++
      return LoopStatus.WARNING
    }

    return LoopStatus.OK
  }

  public recordCommandResult(command: string, exitCode: number): LoopStatus {
    if (exitCode !== 0) {
      this.consecutiveCommandFailures++
      if (this.consecutiveCommandFailures > this.maxFailingCommandsWithoutDiff) {
        return LoopStatus.STALLED
      }
      if (this.consecutiveCommandFailures === this.maxFailingCommandsWithoutDiff) {
        this.totalStallWarnings++
        return LoopStatus.WARNING
      }
    } else {
      this.consecutiveCommandFailures = 0
    }
    return LoopStatus.OK
  }

  public recordProgress(newDiffHash?: string) {
    // Reset repeating loop counters on genuine code progress
    this.toolRepeatCount = 0
    this.lastToolFingerprint = null
    this.consecutiveCommandFailures = 0

    if (newDiffHash && newDiffHash !== this.lastDiffHash) {
      this.lastDiffHash = newDiffHash
      this.totalDiffChanges++
    }
  }

  public getMetrics(): LoopMetrics {
    return {
      tool_repeats: this.totalToolRepeats,
      file_rereads: this.totalFileRereads,
      stall_warnings: this.totalStallWarnings,
      diff_hash_changes: this.totalDiffChanges
    }
  }
}
