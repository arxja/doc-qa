# Webhooks

Webhooks let your server learn about state changes without polling. Register an endpoint in the dashboard; Lumen POSTs a JSON event to it.

## Event types

- `document.sent` — document transitioned to `sent`.
- `document.viewed` — a viewer opened the document.
- `document.completed` — all signers signed; final PDF ready.
- `document.declined` — a recipient declined.
- `document.expired` — evaluated lazily (see signing.md); this event is best-effort.

## Payload

Every event has `id`, `type`, `created_at`, `data.document_id`, and `data.envelope_id`. Verify signatures by comparing the `X-Lumen-Signature` header against HMAC-SHA256 of the raw body using your webhook secret.

## Delivery and retries

Failed deliveries (non-2xx response or timeout after 10 seconds) are retried up to 8 times with exponential backoff starting at 30 seconds. Total retry window is 24 hours. After exhaustion the delivery is marked `failed` and dropped.

Your endpoint must respond within 10 seconds. Slow endpoints will see duplicate deliveries — make your handler idempotent on `event.id`.

## Ordering

Events are **not** guaranteed in order. A `document.completed` may arrive before a `document.viewed`. Use `created_at` to order when it matters, but never assume monotonic delivery.

## Signature verification

```js
const crypto = require("node:crypto");
const expected = crypto
  .createHmac("sha256", secret)
  .update(rawBody)
  .digest("hex");
if (expected !== req.headers["x-lumen-signature"]) throw new Error("bad signature");
```

Use a constant-time comparison in production (`crypto.timingSafeEqual`).
