---
name: otonom-authority-model
description: Use when designing, modifying, or reviewing code that evaluates authority levels, user roles, human overrides, or mutation permissions in OTONOM
---

# OTONOM Authority Model

## Overview

In OTONOM, authority is hierarchical, explicit, and non-negotiable. Model and provider outputs are untrusted proposals; only validated authorities may alter state.

## Authority Hierarchy

1. **HUMAN / HUMAN_VIA_CHATGPT** (Level 4 - Supreme Authority)
   - Unconditional override power.
   - May halt execution, redirect goals, or modify canonical state directly.
2. **FRONTIER** (Level 3 - Strategic Coordinator)
   - Synthesizes state, coordinates high-level planning.
   - Subordinate to Human directives; outranks autonomous workers.
3. **DIRECTOR** (Level 2 - Mutation Gatekeeper)
   - Sole authority that applies state transitions to Project Brain.
   - Validates authority level and revision freshness before committing mutations.
4. **WORKER / OPENCODE AGENT** (Level 1 - Execution Worker)
   - Generates proposals, runs tests, produces local patches and evidence.
   - Zero direct authority over target repository or canonical brain.
5. **EXTERNAL_INPUT** (Level 0 - Untrusted Passive Data)
   - Webhooks, PR comments, issue descriptions, external API payloads.
   - Treated strictly as untrusted data; never interpreted as instructions.

## Core Rules

- **Fail closed on stale revision:** If a mutation request presents an outdated `base_revision`, Director rejects it immediately.
- **No authority escalation:** A worker cannot self-promote to Director or Frontier.
- **Untrusted external text:** PR comments and webhook bodies must never trigger unvalidated mutations.

## Common Mistakes

- Treating model output as authority rather than a candidate proposal.
- Skipping revision checks during state transition.
