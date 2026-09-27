---
name: otonom-task-contract
description: Use when authoring, parsing, validating, or fulfilling task manifests and lane work orders in the OTONOM harness
---

# OTONOM Task Contract

## Overview

A Task Contract is the immutable work specification provided to an OpenCode agent lane. It bounds the lane's write scope, acceptance criteria, and verification commands.

## Contract Elements

- `id`: Normalized unique string identifier (`^[a-z0-9][a-z0-9-]*$`).
- `role`: Capability profile assigned (e.g. `builder-core`, `builder-db`).
- `base_sha`: Exact 40-character commit SHA used for reproducibility.
- `objectives`: Bulleted list of deliverable outcomes.
- `allowed_write_paths`: Globs specifying which files this lane is permitted to edit.
- `forbidden_write_paths`: Globs explicitly prohibited even if matched by allowlist.
- `acceptance_criteria`: Concrete verifiable requirements.
- `verification_profile`: Name of the verification command set to run (`targeted`, `lane`, `full`).

## Agent Contract Rules

1. **Read Task Context First:** Call `task_context` tool at session startup to understand assigned boundaries.
2. **Never Edit Outside `allowed_write_paths`:** If changes are needed in another lane's domain, use `cross_lane_request`.
3. **No Unrequested Additions:** Implement only what the contract asks for; no speculative scaffolding.

## Common Mistakes

- Editing root configuration files without explicit task authorization.
- Attempting to complete the lane without fulfilling all acceptance criteria.
