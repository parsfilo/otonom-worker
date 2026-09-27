---
name: otonom-webhook-durability
description: Use when receiving, processing, retrying, or dead-lettering asynchronous webhook events in OTONOM
---

# OTONOM Webhook Durability

## Overview

Webhooks are external asynchronous events that can be lost, delayed, or delivered multiple times. OTONOM mandates durable logging, idempotency checks, and dead-letter routing.

## Durability Requirements

1. **Acknowledge Fast, Process Durably:** Persist incoming raw payloads immediately to a durable log before complex business logic runs.
2. **Idempotency Enforcement:** Check payload fingerprint or header ID (`X-Webhook-ID`, `Idempotency-Key`) in the database. If already processed, return `200 OK` immediately without duplicate execution.
3. **Dead-Letter Queue (DLQ):** Failed processing after N retries must move the event to DLQ with exact error classification for manual inspection.
4. **Replay Capability:** All webhook processing logic must be safe to re-run from the event log against a specific revision.

## Pipeline Pattern

```
[Webhook Delivery]
       │
       ▼
[Durable Ingress Log] -> (Stores raw event, status: RECEIVED)
       │
       ▼
[Idempotency Check]   -> (Already processed? -> Return 200 OK immediately)
       │ (New event)
       ▼
[Worker Execution]    -> (Process handler with timeout)
       │
   ┌───┴───┐
   ▼       ▼
(SUCCESS) (FAILURE)
   │       │
   ▼       ▼
(COMPLETED) [Retry with Backoff] -> (Exceeded max retries? -> Move to DLQ)
```

## Common Mistakes

- Returning 500 error on duplicate delivery instead of acknowledging idempotently.
- Performing long-running mutations inside the synchronous HTTP webhook handler.
