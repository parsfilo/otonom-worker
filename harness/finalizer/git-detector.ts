import { execSync } from "node:child_process"
import path from "node:path"

export interface GitChangeDetectionOptions {
  workspaceRoot: string
  baseSha: string
  ignoredPaths?: string[]
}

export interface GitChangeSummary {
  actualChangedPaths: string[]
  untrackedPaths: string[]
  deletedPaths: string[]
  renamePairs: Array<{ oldPath: string; newPath: string }>
}

export class GitChangeDetector {
  private workspaceRoot: string
  private baseSha: string
  private ignoredPaths: Set<string>

  constructor(options: GitChangeDetectionOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot)
    this.baseSha = options.baseSha
    this.ignoredPaths = new Set(
      options.ignoredPaths || [
        "task.json",
        "result.json",
        "findings.json",
        "evidence.json",
        "cross-lane-requests.json"
      ]
    )
  }

  public normalizePath(rawPath: string): string {
    let cleaned = rawPath.trim()
    if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
      cleaned = cleaned.slice(1, -1)
    }
    // Normalize slashes
    cleaned = cleaned.replace(/\\/g, "/")

    if (cleaned.includes("\0")) {
      throw new Error(`Path traversal / null byte detected: ${rawPath}`)
    }

    const segments = cleaned.split("/")
    if (segments.includes("..") || cleaned.startsWith("/") || /^[a-zA-Z]:/.test(cleaned)) {
      throw new Error(`Path traversal / invalid path detected: ${rawPath}`)
    }

    const resolved = path.resolve(this.workspaceRoot, cleaned)
    if (!resolved.startsWith(this.workspaceRoot)) {
      throw new Error(`Path escapes workspace root: ${rawPath}`)
    }

    return cleaned
  }

  public detectChanges(): GitChangeSummary {
    const changedPaths = new Set<string>()
    const untrackedPaths = new Set<string>()
    const deletedPaths = new Set<string>()
    const renamePairs: Array<{ oldPath: string; newPath: string }> = []

    const shouldIgnore = (p: string) => {
      if (this.ignoredPaths.has(p)) return true
      if (p.startsWith(".opencode/")) return true
      return false
    }

    // 1. Check working directory status (including untracked and staged/unstaged)
    try {
      const statusOutput = execSync("git status --porcelain=v1 -uall", {
        cwd: this.workspaceRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"]
      })

      const lines = statusOutput.split("\n")
      for (const line of lines) {
        if (!line.trim()) continue
        const code = line.slice(0, 2)
        const rest = line.slice(3).trim()

        if (code === "??") {
          const norm = this.normalizePath(rest)
          if (!shouldIgnore(norm)) {
            changedPaths.add(norm)
            untrackedPaths.add(norm)
          }
        } else if (code.includes("R")) {
          // Rename format: "old -> new"
          const parts = rest.split(" -> ")
          if (parts.length === 2) {
            const oldPath = this.normalizePath(parts[0])
            const newPath = this.normalizePath(parts[1])
            if (!shouldIgnore(oldPath)) changedPaths.add(oldPath)
            if (!shouldIgnore(newPath)) changedPaths.add(newPath)
            renamePairs.push({ oldPath, newPath })
          }
        } else if (code.includes("D")) {
          const norm = this.normalizePath(rest)
          if (!shouldIgnore(norm)) {
            changedPaths.add(norm)
            deletedPaths.add(norm)
          }
        } else {
          // Modified or added
          const norm = this.normalizePath(rest)
          if (!shouldIgnore(norm)) {
            changedPaths.add(norm)
          }
        }
      }
    } catch (err: any) {
      throw new Error(`Failed to execute git status: ${err.message}`)
    }

    // 2. Check diff against authoritative base SHA
    try {
      const diffOutput = execSync(`git diff --name-status -M ${this.baseSha}`, {
        cwd: this.workspaceRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"]
      })

      const lines = diffOutput.split("\n")
      for (const line of lines) {
        if (!line.trim()) continue
        const parts = line.split("\t")
        const status = parts[0]

        if (status.startsWith("R") && parts.length >= 3) {
          const oldPath = this.normalizePath(parts[1])
          const newPath = this.normalizePath(parts[2])
          if (!shouldIgnore(oldPath)) changedPaths.add(oldPath)
          if (!shouldIgnore(newPath)) changedPaths.add(newPath)
          if (!renamePairs.some((r) => r.oldPath === oldPath && r.newPath === newPath)) {
            renamePairs.push({ oldPath, newPath })
          }
        } else if (status === "D" && parts.length >= 2) {
          const norm = this.normalizePath(parts[1])
          if (!shouldIgnore(norm)) {
            changedPaths.add(norm)
            deletedPaths.add(norm)
          }
        } else if (parts.length >= 2) {
          const norm = this.normalizePath(parts[1])
          if (!shouldIgnore(norm)) {
            changedPaths.add(norm)
          }
        }
      }
    } catch {
      // baseSha might be HEAD or unresolvable in detached/fixture modes
    }

    return {
      actualChangedPaths: Array.from(changedPaths).sort(),
      untrackedPaths: Array.from(untrackedPaths).sort(),
      deletedPaths: Array.from(deletedPaths).sort(),
      renamePairs
    }
  }

  public reconcileWithReported(reportedPaths: string[]): {
    valid: boolean
    error?: string
    discrepancies?: {
      unreported: string[]
      uncommitted: string[]
    }
  } {
    const summary = this.detectChanges()
    const actualSet = new Set(summary.actualChangedPaths)

    // Normalize reported paths
    const reportedNormalized = new Set<string>()
    for (const r of reportedPaths) {
      reportedNormalized.add(this.normalizePath(r))
    }

    const unreported: string[] = []
    for (const actual of actualSet) {
      // For rename pairs, if the new path is reported, that's what an agent normally reports
      const isOldRename = summary.renamePairs.some(
        (pair) => pair.oldPath === actual && reportedNormalized.has(pair.newPath)
      )
      if (!reportedNormalized.has(actual) && !isOldRename) {
        unreported.push(actual)
      }
    }

    const uncommitted: string[] = []
    for (const reported of reportedNormalized) {
      if (!actualSet.has(reported)) {
        uncommitted.push(reported)
      }
    }

    if (unreported.length > 0) {
      return {
        valid: false,
        error: `Unreported changed file(s) detected in Git: ${unreported.join(", ")}`,
        discrepancies: { unreported, uncommitted }
      }
    }

    if (uncommitted.length > 0) {
      return {
        valid: false,
        error: `Reported changed file that was not modified in Git: ${uncommitted.join(", ")}`,
        discrepancies: { unreported, uncommitted }
      }
    }

    return { valid: true }
  }
}
