# Signing flow

A signing flow moves a document from `draft` to `completed`. Each step emits a webhook (see webhooks.md). The flow is asynchronous: creating a document returns `202 Accepted` and the actual send happens shortly after.

## State machine

Documents move through these states in order:

1. `draft` — created, not yet sent. Fully editable.
2. `sent` — recipients have been notified.
3. `in_progress` — at least one recipient has signed, others pending.
4. `completed` — all recipients signed and the final PDF is available.
5. `declined` — a recipient declined. Terminal.
6. `expired` — the expiration time passed before completion. Terminal.

Transitions out of `completed`, `declined`, and `expired` are not permitted. Attempting one returns `E_VALIDATION`.

## Sending a document

To send, POST the document and recipients in one call:

```bash
curl -X POST https://api.lumen.example/v1/documents \
  -H "Authorization: Bearer lmn_live_..." \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"title":"MSA","recipients":[{"email":"a@example.com","role":"signer"}]}'
```

The response includes `id` and `status: "sent"`. The document is emailed to each recipient in the order listed. If any recipient email is malformed, the entire request fails with `E_VALIDATION` — no partial sends.

## Recipient actions

- A `signer` can sign or decline. Signing records the signer's name, email, timestamp, and IP.
- A `viewer` can only open the document. Viewing emits `document.viewed` but does not advance the state.
- An `approver` can approve or reject without a signature image.

## Expiration

Documents expire after the `expiration_days` field (default 30, max 365). Expired documents move to `expired` and cannot be re-sent; you must create a new document. Expiration is evaluated lazily — a document past its expiration will show as `expired` on the next read, but the state is not pushed via webhook.
