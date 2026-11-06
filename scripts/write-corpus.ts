import { mkdir, writeFile } from "node:fs/promises";

const files: Record<string, string> = {
  "index.md": `# Lumen API

Lumen is a document-signing API. You create a document, send it for signature, and receive webhooks as recipients sign.

## Overview

The API is REST over HTTPS. All requests go to \`https://api.lumen.example/v1\`. Requests and responses are JSON. Every response includes a \`request_id\` header you can quote in support tickets.

## Core concepts

- **Document** — a PDF plus metadata (title, recipients, expiration).
- **Recipient** — a person asked to sign, view, or approve a document. Each recipient has a role: \`signer\`, \`viewer\`, or \`approver\`.
- **Envelope** — the container that tracks a document through its lifecycle.
- **Event** — a webhook payload emitted when something changes.

## Versioning

The path prefix (\`/v1\`) is the only versioning mechanism. Breaking changes ship under a new prefix; additive changes (new optional fields, new event types) ship in-place.
`,

  "errors.md": `# Errors

Errors return a JSON body with \`code\`, \`message\`, and \`request_id\`. HTTP status matches the error family (4xx client, 5xx server). You should not retry 4xx errors except \`E_RATE_LIMIT\`.

## Code format

Codes follow \`E_<FAMILY>_<HTTP_STATUS>\` or a specific suffix, for example \`E_DOC_NOT_FOUND\`. The \`code\` is stable; the \`message\` may change.

## Common errors

| Code | HTTP | Meaning |
|---|---|---|
| \`E_AUTH_401\` | 401 | Invalid or revoked credentials |
| \`E_AUTH_403\` | 403 | Missing scope |
| \`E_DOC_NOT_FOUND\` | 404 | Document does not exist or is not visible to this team |
| \`E_VALIDATION\` | 422 | Request body failed schema validation |
| \`E_RATE_LIMIT\` | 429 | Rate limit exceeded (see rate-limits.md) |
| \`E_INTERNAL\` | 500 | Unexpected server error; safe to retry with backoff |

## Negation cases

A \`viewer\` recipient **cannot** delete a document. Deletion requires the \`admin\` scope and is only permitted on documents in \`draft\` state. A \`signer\` **cannot** change recipient roles after sending. If you need either capability, you must use an \`admin\`-scoped key.

## Idempotency

POST requests accept an \`Idempotency-Key\` header. Replaying a request with the same key within 24 hours returns the original response without re-executing the side effect.
`,

  "authentication.md": `# Authentication

Every request must carry an API key in the \`Authorization\` header as \`Bearer <key>\`. Keys are scoped to a single team.

## API keys

Create keys in the dashboard under **Settings → API keys**. A key looks like \`lmn_live_...\` or \`lmn_test_...\`. Test keys operate against test documents and never send real email.

Keys have three permission scopes:

- \`read\` — can fetch documents, envelopes, and events.
- \`write\` — can create and modify documents.
- \`admin\` — can manage team members and rotate keys.

A key without the required scope returns \`E_AUTH_403\`.

### Rotation

Rotate keys every 90 days. Rotation is zero-downtime: create the new key, deploy it, then revoke the old one. Revoked keys return \`E_AUTH_401\` immediately.

## OAuth 2.0

For third-party integrations, use OAuth 2.0 authorization code flow. The authorize endpoint is \`https://api.lumen.example/oauth/authorize\`. Tokens expire after 3600 seconds; refresh tokens are valid for 30 days.

## Authentication errors

| Code | Meaning |
|---|---|
| \`E_AUTH_401\` | Missing, malformed, or revoked key |
| \`E_AUTH_403\` | Key lacks the required scope |
| \`E_AUTH_429\` | Too many auth attempts from this IP |
`,

  "signing.md": `# Signing flow

A signing flow moves a document from \`draft\` to \`completed\`. Each step emits a webhook (see webhooks.md). The flow is asynchronous: creating a document returns \`202 Accepted\` and the actual send happens shortly after.

## State machine

Documents move through these states in order:

1. \`draft\` — created, not yet sent. Fully editable.
2. \`sent\` — recipients have been notified.
3. \`in_progress\` — at least one recipient has signed, others pending.
4. \`completed\` — all recipients signed and the final PDF is available.
5. \`declined\` — a recipient declined. Terminal.
6. \`expired\` — the expiration time passed before completion. Terminal.

Transitions out of \`completed\`, \`declined\`, and \`expired\` are not permitted. Attempting one returns \`E_VALIDATION\`.

## Sending a document

To send, POST the document and recipients in one call:

\`\`\`bash
curl -X POST https://api.lumen.example/v1/documents \\
  -H "Authorization: Bearer lmn_live_..." \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"title":"MSA","recipients":[{"email":"a@example.com","role":"signer"}]}'
\`\`\`

The response includes \`id\` and \`status: "sent"\`. The document is emailed to each recipient in the order listed. If any recipient email is malformed, the entire request fails with \`E_VALIDATION\` — no partial sends.

## Recipient actions

- A \`signer\` can sign or decline. Signing records the signer's name, email, timestamp, and IP.
- A \`viewer\` can only open the document. Viewing emits \`document.viewed\` but does not advance the state.
- An \`approver\` can approve or reject without a signature image.

## Expiration

Documents expire after the \`expiration_days\` field (default 30, max 365). Expired documents move to \`expired\` and cannot be re-sent; you must create a new document. Expiration is evaluated lazily — a document past its expiration will show as \`expired\` on the next read, but the state is not pushed via webhook.
`,

  "webhooks.md": `# Webhooks

Webhooks let your server learn about state changes without polling. Register an endpoint in the dashboard; Lumen POSTs a JSON event to it.

## Event types

- \`document.sent\` — document transitioned to \`sent\`.
- \`document.viewed\` — a viewer opened the document.
- \`document.completed\` — all signers signed; final PDF ready.
- \`document.declined\` — a recipient declined.
- \`document.expired\` — evaluated lazily (see signing.md); this event is best-effort.

## Payload

Every event has \`id\`, \`type\`, \`created_at\`, \`data.document_id\`, and \`data.envelope_id\`. Verify signatures by comparing the \`X-Lumen-Signature\` header against HMAC-SHA256 of the raw body using your webhook secret.

## Delivery and retries

Failed deliveries (non-2xx response or timeout after 10 seconds) are retried up to 8 times with exponential backoff starting at 30 seconds. Total retry window is 24 hours. After exhaustion the delivery is marked \`failed\` and dropped.

Your endpoint must respond within 10 seconds. Slow endpoints will see duplicate deliveries — make your handler idempotent on \`event.id\`.

## Ordering

Events are **not** guaranteed in order. A \`document.completed\` may arrive before a \`document.viewed\`. Use \`created_at\` to order when it matters, but never assume monotonic delivery.

## Signature verification

\`\`\`js
const crypto = require("node:crypto");
const expected = crypto
  .createHmac("sha256", secret)
  .update(rawBody)
  .digest("hex");
if (expected !== req.headers["x-lumen-signature"]) throw new Error("bad signature");
\`\`\`

Use a constant-time comparison in production (\`crypto.timingSafeEqual\`).
`,
};

await mkdir("data/corpus", { recursive: true });
for (const [name, content] of Object.entries(files)) {
  await writeFile(`data/corpus/${name}`, content, "utf8");
  console.log(`wrote data/corpus/${name}`);
}
