/**
 * Command Security Policy (Defense-in-Depth Layer)
 *
 * ARCHITECTURAL SECURITY NOTE:
 * Shell regex/pattern matching is STRICTLY DEFENSE-IN-DEPTH and never an absolute sandbox.
 * The TRUE trust boundaries enforced in the OTONOM Swarm Harness are:
 * 1. ZERO GitHub target write tokens or Doppler secrets exist in the agent execution environment.
 * 2. Target repository source is cloned with ephemeral read-only credentials, stripped before agent launch.
 * 3. OpenCode runs in an unprivileged CI runner with core.hooksPath=/dev/null and credential.helper="".
 * 4. The Trusted Finalizer calculates actual changed files directly from Git and runs verification independently.
 *
 * This policy serves to detect and immediately abort obvious unauthorized operations.
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

// Normalize a command segment: strip path prefixes like /usr/bin/, strip command/env wrappers
function unwrapCommand(segment: string): string {
  let cleaned = segment.replace(/\s+/g, " ").trim()

  // Strip common wrapper prefixes: "command", "env", path prefixes
  cleaned = cleaned.replace(/^\s*(?:\/usr\/bin\/|\/bin\/|\/usr\/local\/bin\/)/, "")
  cleaned = cleaned.replace(/^\s*command\s+/, "")
  cleaned = cleaned.replace(/^\s*env(?:\s+-[a-zA-Z0-9]+|\s+[A-Za-z_][A-Za-z0-9_]*=[^\s]+)*\s+/, "")

  return cleaned.trim()
}

export function evaluateCommandPolicy(fullCommand: string): CommandPolicyResult {
  const segments = splitPipeline(fullCommand)

  for (const rawSegment of segments) {
    const normalized = unwrapCommand(rawSegment)

    // Check for nested subshell commands: bash -c "...", sh -c '...'
    const subshellMatch = normalized.match(/^(?:bash|sh|zsh|dash)\s+-c\s+["'](.+)["']$/i)
    if (subshellMatch) {
      const innerCheck = evaluateCommandPolicy(subshellMatch[1])
      if (!innerCheck.allowed) {
        return innerCheck
      }
    }

    // Check for script runners with embedded git push or network commands
    if (
      /^(?:node|python|python3|perl|ruby)\s+(?:-e|-c)\s+.*git\s+push/i.test(normalized) ||
      /^(?:node|python|python3|perl|ruby)\s+(?:-e|-c)\s+.*child_process.*git/i.test(normalized)
    ) {
      return {
        allowed: false,
        reason: "Spawning git push via script runtime is strictly forbidden."
      }
    }

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

    // 6. Block exfiltration / reverse shell tools
    if (
      /\b(?:nc|ncat|netcat|socat)\b/i.test(normalized) ||
      /\bcurl\b(?:\s+[^;|&]+)*(?:-X\s*(?:POST|PUT)|-d\b|--data\b|-F\b|--upload-file\b)/i.test(normalized) ||
      /\bwget\b(?:\s+[^;|&]+)*(?:--post-data|--post-file)/i.test(normalized)
    ) {
      return {
        allowed: false,
        reason: "Network data exfiltration and reverse shell utilities are forbidden."
      }
    }

    // 7. Block environment / credential dumping
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

    // 8. Block destructive host commands
    if (/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\s+(\/|~|\$HOME)\b/i.test(normalized)) {
      return {
        allowed: false,
        reason: "Destructive host deletion command detected."
      }
    }
  }

  return { allowed: true }
}
