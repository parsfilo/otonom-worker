---
name: headless-ci-shell
description: Use when running shell commands, inspecting files, or executing build tools in a headless non-interactive CI runner environment
---

# Headless CI Shell

## Overview

In GitHub Actions headless environments, there is no interactive TTY, no user confirmation prompt, and no interactive browser or editor. All shell interactions must be non-interactive and deterministic.

## Non-Interactive Invariants

1. **No Interactive Prompts:** Commands that wait for user confirmation (e.g. `npm init`, `git add -p`, `read -p`) will hang until runner timeout. Always pass non-interactive flags (`-y`, `--non-interactive`, `--batch`).
2. **Terminal Settings:** Use `PAGER=cat`, `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `NO_COLOR=1`.
3. **Bounded Output:** Do not emit megabytes of raw text to console. Pipe verbose commands or use quiet flags (`--silent`, `-q`, `head -n 50`).
4. **Exit Codes Matter:** In CI, non-zero exit codes signal failure. Always check exit codes before chaining commands.

## Common Mistakes

- Running commands that open a pager like `less` (hangs headless CI).
- Running interactive git commands.
