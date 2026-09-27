---
name: otonom-github-boundary
description: Use when interacting with GitHub APIs, managing git credentials, creating pull requests, or defining branch isolation policies
---

# OTONOM GitHub Boundary

## Overview

The target repository (`oaslananka/otonom`) is private and protected. The worker repository (`parsfilo/otonom-worker`) is public and temporary. Strict boundaries govern all interactions with GitHub.

## Boundary Rules

1. **Public Repository Threat Model:** Assume all Actions workflow logs and runner consoles in `parsfilo/otonom-worker` are public. Never output private code, diffs, or credentials to logs.
2. **Branch Isolation:** Each lane works on a deterministic, isolated branch:
   `swarm/<workflow-run-id>/<normalized-task-id>`
3. **No Cross-Lane Branch Pollution:** An agent running in lane A cannot inspect, fetch, or push to lane B's branch.
4. **Trigger Restriction:** Swarm workflows are triggered ONLY via `workflow_dispatch`. Public pull requests, forks, issues, and comments never trigger worker agents.
5. **Write Credential Injection Gate:** Write tokens are injected strictly into the finalizer step AFTER the agent process is terminated and verification has succeeded.

## Common Mistakes

- Using `set -x` or printing environment dumps in Actions workflows.
- Permitting automatic workflow runs from public fork PRs.
