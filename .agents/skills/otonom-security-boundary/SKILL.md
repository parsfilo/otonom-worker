---
name: otonom-security-boundary
description: Use when auditing code against injection vulnerabilities, credential exposure, data exfiltration, or untrusted external inputs in OTONOM
---

# OTONOM Security Boundary

## Overview

The OTONOM security model assumes all worker runtime environments and external inputs are hostile or untrusted. Defense-in-depth is enforced at process, file, and network levels.

## Core Defenses

1. **No Sensitive Environment Variables:** Sensitive tokens (Doppler, GitHub PAT, cloud keys) are stripped from agent shell execution by `shell.env`.
2. **Blocked Dangerous Shell Commands:** `git push`, `gh auth`, `gh pr`, `sudo`, `ssh`, and environment dumping tools (`printenv`) are intercepted and denied by `tool.execute.before`.
3. **Strict Path Ownership:** OpenCode cannot write to files outside its assigned task contract. Out-of-scope edits raise `OUT_OF_SCOPE_WRITE` and fail the lane.
4. **Log Sanitization:** Public GitHub Actions logs never contain raw tokens, JWTs, private keys, or source code diffs.
5. **No Network Privilege for Shell:** Model commands cannot open outbound SSH or shell sessions to arbitrary remote hosts.

## Common Mistakes

- Trusting regex masking alone without physical token stripping.
- Allowing subagent processes to inherit runner credentials.
