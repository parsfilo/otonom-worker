/**
 * Command Security Policy
 * Normalizes shell command strings and blocks dangerous operations:
 * - Remote git modifications (push, push --force)
 * - GitHub PR or authentication operations (gh pr create, gh auth token)
 * - Privilege escalation (sudo, su)
 * - Remote access (ssh, scp)
 * - Credential exfiltration / dumping (printenv, reading secrets)
 */

export interface CommandPolicyResult {
  allowed: boolean
  reason?: string
}

// Split chained commands by ;, &&, ||, |
function splitPipeline(commandStr: string): string[] {
  return commandStr
    .split(/(&&|\|\||;|\||\n)/)
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0 && !["&&", "||", ";", "|"].includes(seg))
}

// Normalize a command segment: trim whitespace, collapse spaces
function normalizeSegment(segment: string): string {
  return segment.replace(/\s+/g, " ").trim()
}

export function evaluateCommandPolicy(fullCommand: string): CommandPolicyResult {
  const segments = splitPipeline(fullCommand)

  for (const segment of segments) {
    const normalized = normalizeSegment(segment)

    // 1. Block git push (any flags, directory overrides, options)
    if (/\bgit\b(?:\s+[^;|&]+)*\s+push\b/i.test(normalized)) {
      return {
        allowed: false,
        reason: "Git push is strictly forbidden. The trusted finalizer owns repository pushes."
      }
    }

    // 2. Block gh pr commands
    if (/\bgh\s+pr\s+(create|merge|close|edit)\b/i.test(normalized)) {
      return {
        allowed: false,
        reason: "GitHub PR operations from OpenCode agent are forbidden. The finalizer creates PRs."
      }
    }

    // 3. Block gh auth commands
    if (/\bgh\s+auth\s+(token|status|login|setup-git)\b/i.test(normalized)) {
      return {
        allowed: false,
        reason: "Inspecting or modifying GitHub credentials via gh CLI is forbidden."
      }
    }

    // 4. Block sudo / su
    if (/^\s*(sudo|su)\b/i.test(normalized)) {
      return {
        allowed: false,
        reason: "Privilege escalation is forbidden in worker containers."
      }
    }

    // 5. Block ssh / scp / sftp
    if (/^\s*(ssh|scp|sftp)\b/i.test(normalized)) {
      return {
        allowed: false,
        reason: "Remote network connections via SSH/SCP are forbidden."
      }
    }

    // 6. Block environment / credential dumping
    if (
      /^\s*(printenv|export|env)\s*$/i.test(normalized) ||
      /\bcat\s+.*\/proc\/.*\/environ/i.test(normalized) ||
      /\b(cat|head|tail|less|more|od|xxd|strings)\s+.*(\.ssh|\.aws|\.env)\b/i.test(normalized)
    ) {
      return {
        allowed: false,
        reason: "Arbitrary credential dumping and reading secret files is forbidden."
      }
    }

    // 7. Block destructive host commands
    if (/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\s+(\/|~|\$HOME)\b/i.test(normalized)) {
      return {
        allowed: false,
        reason: "Destructive host deletion command detected."
      }
    }
  }

  return { allowed: true }
}
