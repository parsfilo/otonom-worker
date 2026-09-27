---
name: otonom-pr-guard
description: Use when assembling pull request metadata, validating PR bodies, or verifying that PR artifacts comply with sanitization policies
---

# OTONOM PR Guard

## Overview

The PR Guard governs how completed swarm lanes are presented to the target repository as Pull Requests. It enforces strict metadata boundaries and prevents confidential leaks.

## PR Metadata Contract

A valid Swarm PR body contains:
- Task ID and title
- Base commit SHA and target branch
- High-level objective checklist
- Mechanical verification summary (command profiles, exit codes, test counts)
- Risk classification and review profile

A Swarm PR body NEVER contains:
- Raw source code snippets
- Raw git diff patches
- Raw OpenCode agent conversational transcripts
- Environment variables or credential markers

## Gate Sequence

```
1. Validate result.json schema
2. Validate changed paths against task.allowed_write_paths
3. Run secret scanner on changed path list
4. Verify passing test execution evidence
5. Construct sanitized PR body
6. Finalizer executes branch push and PR creation
```

## Common Mistakes

- Copying raw agent reasoning logs into PR descriptions.
- Creating PRs when test results show failures or regressions.
