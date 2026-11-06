// Extended corpus writer — writes the 15 "rest of the docs" pages.
// Same pattern as write-corpus.ts: literal strings, no heredocs, no shell escaping.
// Adding pages DOES NOT change existing chunk IDs (id = `${docId}#${i}`),
// so the 20-query eval set (evals/queries-d2.json) remains valid after this run.
//
// Purpose: un-saturate hit@10. 5 pages / 25 chunks -> ~20 pages / ~140 chunks.

import { mkdir, writeFile } from "node:fs/promises";

const files: Record<string, string> = {
  "quickstart.md": `# Quickstart

Get a document signed in under 10 minutes. This guide uses the JavaScript SDK. Python users can follow the same steps with \`lumen-python\` — the API surface is identical.

## Prerequisites

- A Lumen account (create one at https://app.lumen.example/signup)
- A team API key with \`write\` scope (see authentication.md)
- Node.js 20+ for the JavaScript SDK

## Install the SDK

\`\`\`bash
npm install @lumen/sdk
\`\`\`

The JavaScript SDK ships as both ESM and CommonJS. For TypeScript, types are bundled — no \`@types/\` package needed.

## Your first document

Create a document and send it to a single signer in one call:

\`\`\`js
import { Lumen } from "@lumen/sdk";

const lumen = new Lumen({ apiKey: process.env.LUMEN_API_KEY });

const doc = await lumen.documents.create({
  title: "Mutual NDA",
  recipients: [
    { email: "alice@example.com", role: "signer" },
  ],
  expiration_days: 30,
});

console.log(doc.id, doc.status); // "doc_abc123", "sent"
\`\`\`

The \`status\` is \`sent\` immediately; actual delivery happens asynchronously (see signing.md). Each recipient receives an email with a signing link. Subscribe to webhooks (see webhooks.md) to know when the document is \`completed\`.

## Checking status

Poll the document or wait for the \`document.completed\` webhook:

\`\`\`js
const doc = await lumen.documents.retrieve("doc_abc123");
if (doc.status === "completed") {
  const pdf = await lumen.documents.downloadSigned("doc_abc123");
}
\`\`\`

## Next steps

- authentication.md — API keys, OAuth, scopes
- signing.md — state machine and recipient actions
- webhooks.md — react to document events
- sdk-javascript.md, sdk-python.md — SDK reference
`,

  "rate-limits.md": `# Rate limits

Rate limits protect the platform and are enforced per team. Every response includes headers showing your current budget; check them before sending large batches.

## Limits by plan

| Plan | Requests per minute | Burst | Concurrent requests |
|---|---|---|---|
| Free | 30 | 10 | 2 |
| Pro | 300 | 100 | 10 |
| Enterprise | 3000 | 500 | 50 |

Limits are enforced at the team level, not the API-key level. If you use multiple keys under one team, they share the same budget.

## Headers

Every response includes:

- \`X-RateLimit-Limit\` — the request-per-minute limit for your plan
- \`X-RateLimit-Remaining\` — requests left in the current window
- \`X-RateLimit-Reset\` — Unix timestamp (seconds) when the window resets

## When you exceed the limit

Requests over the limit return HTTP 429 with error code \`E_RATE_LIMIT\`. The body includes a \`retry_after\` field (seconds) — respect it:

\`\`\`json
{
  "code": "E_RATE_LIMIT",
  "message": "Rate limit exceeded for team team_xyz",
  "retry_after": 12,
  "request_id": "req_abc123"
}
\`\`\`

Retrying before \`retry_after\` has elapsed extends the penalty window. Retrying with exponential backoff is safe but slower than reading the header.

## Webhook delivery and rate limits

Webhook deliveries count against a **separate** budget from your API requests. Webhook limits follow the same plan tiers at 10× the API rate (Free: 300/min, Pro: 3000/min, Enterprise: 30000/min).

## Endpoint-specific limits

A few endpoints have stricter limits than the plan-wide rate:

- \`POST /v1/documents\` — max 10 per minute on Free, 100 on Pro, 1000 on Enterprise
- \`GET /v1/documents/:id/download\` — max 5 per minute on all plans
- \`POST /v1/teams/:id/members\` — max 20 per minute on all plans

Endpoint-specific limits return \`E_RATE_LIMIT\` with a \`scope\` field indicating which limit was hit.
`,

  "documents.md": `# Documents

A document is a PDF plus metadata: title, recipients, expiration, and status. Documents are the primary resource — everything else (webhooks, templates, teams) exists to serve them.

## Document object

| Field | Type | Notes |
|---|---|---|
| \`id\` | string | \`doc_\` prefix, immutable |
| \`title\` | string | Up to 200 characters |
| \`status\` | enum | \`draft\`, \`sent\`, \`in_progress\`, \`completed\`, \`declined\`, \`expired\` |
| \`recipients\` | array | Ordered by signing order |
| \`expiration_days\` | integer | 1–365, default 30 |
| \`created_at\` | ISO 8601 | Read-only |
| \`completed_at\` | ISO 8601 or null | Set when status becomes \`completed\` |

## Create a document

\`\`\`bash
curl -X POST https://api.lumen.example/v1/documents \\
  -H "Authorization: Bearer lmn_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "MSA",
    "recipients": [
      {"email": "alice@example.com", "role": "signer"},
      {"email": "bob@example.com", "role": "approver", "order": 2}
    ],
    "expiration_days": 14
  }'
\`\`\`

Returns HTTP 202 with the document \`id\` and \`status: "sent"\`. The send is asynchronous — actual email delivery happens within 30 seconds.

## Retrieve a document

\`GET /v1/documents/:id\` returns the full document including recipients and their signing status. Use \`include=recipients\` to fetch recipient history in the same call.

## List documents

\`GET /v1/documents\` returns documents for the calling team, paginated at 50 per page. Filters: \`status\`, \`created_after\`, \`created_before\`, \`recipient_email\`.

## Update a document

Only \`draft\` documents can be updated. Attempting to update a \`sent\` document returns \`E_VALIDATION\` with \`details: "document is not editable in status sent"\`.

## Delete a document

Requires \`admin\` scope. Only \`draft\` documents can be deleted. \`sent\`, \`in_progress\`, \`completed\`, \`declined\`, and \`expired\` documents are retained for audit purposes and cannot be deleted via the API. Deleting a draft returns HTTP 204.

## Download the signed PDF

\`GET /v1/documents/:id/download\` returns a signed URL valid for 15 minutes. Only available when \`status: "completed"\` — returns \`E_VALIDATION\` otherwise.
`,

  "templates.md": `# Templates

A template is a reusable document definition: title, recipients, and field placeholders. Templates save time when you send the same kind of document repeatedly (e.g., NDAs, MSAs).

## Template object

| Field | Type | Notes |
|---|---|---|
| \`id\` | string | \`tpl_\` prefix |
| \`name\` | string | Up to 100 characters |
| \`recipients\` | array | Role definitions, not specific people |
| \`fields\` | array | Named placeholders with types (text, date, signature) |
| \`created_at\` | ISO 8601 | Read-only |

## Create a template

\`POST /v1/templates\` accepts the template definition. Fields declare named placeholders that are filled at send time.

## Send from a template

\`POST /v1/templates/:id/send\` instantiates the template into a document. Recipient emails and field values are supplied at send time; the template itself is unchanged. Returns the new document with \`status: "sent"\`.

## Template limits

- Maximum 50 templates per team on Free, 500 on Pro, unlimited on Enterprise
- Maximum 100 fields per template
- Templates cannot be edited after the first send. To change a template, create a new one and archive the old.

## Archiving

Archived templates cannot be sent from but remain readable. Archiving is reversible; deleting is not. Archived templates do not count toward the template limit.
`,

  "teams.md": `# Teams

A team is the top-level container for documents, templates, API keys, and users. Every API key is scoped to exactly one team. Teams are isolated — one team cannot see another's resources.

## Team object

| Field | Type | Notes |
|---|---|---|
| \`id\` | string | \`team_\` prefix |
| \`name\` | string | Up to 100 characters |
| \`plan\` | enum | \`free\`, \`pro\`, \`enterprise\` |
| \`created_at\` | ISO 8601 | Read-only |

## Members

Team members are users with access to the team's dashboard. API keys are separate from members — a member is a human; an API key is a program. Invite members via \`POST /v1/teams/:id/members\`. Invitation emails expire after 7 days.

## Member roles

| Role | Can read | Can create/edit docs | Can manage members | Can rotate keys |
|---|---|---|---|---|
| \`viewer\` | ✓ | | | |
| \`member\` | ✓ | ✓ | | |
| \`admin\` | ✓ | ✓ | ✓ | ✓ |
| \`owner\` | ✓ | ✓ | ✓ | ✓ + billing |

There is exactly one \`owner\` per team. Transferring ownership is done via \`PATCH /v1/teams/:id\` with a \`new_owner_email\` field. The previous owner becomes an \`admin\`.

## Removals

Removing a member does not delete their signed documents — document history is retained for audit. The member loses dashboard access immediately; active sessions are invalidated within 60 seconds.

## Teams and API keys

All API keys belong to a team and inherit its plan rate limits (see rate-limits.md). Multiple API keys under the same team share the same rate limit budget. If you need separate rate budgets, create separate teams.
`,

  "billing.md": `# Billing

Billing is per-team and monthly. Each team is charged on the anniversary of its upgrade date. Invoices are available in the dashboard under **Settings → Billing**.

## Plans

| Plan | Monthly price | Documents/month | Rate limit |
|---|---|---|---|
| Free | $0 | 50 | 30 req/min |
| Pro | $49 | 1000 | 300 req/min |
| Enterprise | Custom | Custom | 3000 req/min |

Plans differ in document quota and rate limits (see rate-limits.md). All plans include the full API surface — no features are gated behind a plan.

## Overage

Free plan stops at 50 documents/month; further \`POST /v1/documents\` calls return \`E_QUOTA_EXCEEDED\`. Pro and Enterprise support overage at $0.05 per document above the monthly quota, billed at month end.

## Payment methods

Credit cards (Visa, Mastercard, Amex) and bank transfers (Enterprise only). The dashboard stores the primary card; you can add a backup card that is charged if the primary fails.

## Failed payments

When a charge fails, the team enters \`past_due\` status. In \`past_due\`:

- New documents cannot be created (returns \`E_BILLING\`)
- Existing in-flight documents continue to work
- Webhook delivery continues

Payment is retried after 3 days, 7 days, and 14 days. After 14 days without payment, the team is downgraded to Free and its API keys are disabled.

## Upgrades

Upgrading takes effect immediately. You are charged the prorated amount for the current billing period. The new rate limits apply instantly.

## Invoices

Invoices are emailed on the 1st of the month for the previous month's usage. Invoices are also accessible via \`GET /v1/billing/invoices\` (Enterprise only — Pro and Free plans see invoices in the dashboard only).
`,

  "security.md": `# Security

Security is layered: transport, storage, access, and audit. This page documents each layer.

## Transport

All API traffic is TLS 1.2+ (TLS 1.3 preferred). The API rejects plaintext HTTP at the load balancer with HTTP 301 to HTTPS. HSTS is enabled with a 1-year max-age.

Webhook deliveries use the same TLS requirements. Endpoints that do not support TLS 1.2+ receive \`E_WEBHOOK_TLS\` and the delivery is retried per the retry policy (see webhooks.md).

## Storage

Documents at rest are encrypted with AES-256. Encryption keys are managed in a KMS with automatic rotation every 90 days. Signed PDFs are stored in object storage with server-side encryption.

Metadata (document titles, recipient emails, statuses) lives in a database encrypted at rest using the same KMS. Backups are encrypted with the same keys and retained for 30 days.

## Access

Access is controlled by scopes (see authentication.md). Dashboard access requires a verified email and optionally two-factor authentication (TOTP or SMS). API keys never grant dashboard access.

Admin-scoped API keys can rotate other keys, invite members, and change team settings. Treat them as secrets with the same care as passwords.

## Audit log

Every API call is logged with \`request_id\`, \`team_id\`, \`key_id\`, method, path, and response status. Audit logs are retained for 90 days on Free, 1 year on Pro, 7 years on Enterprise. \`GET /v1/audit-logs\` returns them (Enterprise only).

## Compliance certifications

Lumen holds SOC 2 Type II and is GDPR-compliant. See compliance.md for details, DPA availability, and data residency.

## Vulnerability disclosure

Security issues should be reported to security@lumen.example (PGP key on the website). We acknowledge reports within 48 hours. We do not currently operate a bug bounty program.
`,

  "compliance.md": `# Compliance

Lumen is designed for teams with compliance obligations. This page documents certifications, data handling, and audit support.

## Certifications

- **SOC 2 Type II** — audited annually. Report available to Pro and Enterprise customers under NDA.
- **GDPR** — Lumen acts as a data processor for customer data. DPA available on request.
- **CCPA** — Compliant for California residents.

Lumen is not currently HIPAA-certified. Teams with PHI-handling requirements should contact sales to discuss alternatives.

## Data processing agreement (DPA)

DPAs are available to Pro and Enterprise teams. Request via legal@lumen.example. Standard DPA covers categories of personal data (name, email, IP address), purposes of processing (contract execution), sub-processors (AWS, Sendgrid), and data subject rights (access, erasure, portability). Execution typically takes 5–10 business days.

## Data residency

All data is stored in the United States (us-east-1, us-west-2). Cross-region replication is within US borders only. Data does not leave the United States under any configuration.

## Sub-processors

| Sub-processor | Function | Location |
|---|---|---|
| AWS | Hosting, storage | United States |
| Sendgrid | Email delivery | United States |
| Datadog | Logging, monitoring | United States |

30-day notice is provided before adding a sub-processor.

## Data retention

- Documents: retained indefinitely for audit unless deleted (only drafts can be deleted — see documents.md)
- Audit logs: 90 days (Free), 1 year (Pro), 7 years (Enterprise)
- Backups: 30 days rolling

## Data subject requests

GDPR and CCPA data subject requests are handled via \`DELETE /v1/teams/:id/data\` (erasure) or by emailing privacy@lumen.example. Erasure requests complete within 30 days. Note that signed documents are legal records and may be exempt from erasure.

## Right to audit

Enterprise teams may conduct an annual security audit of Lumen's controls. Contact sales to schedule.
`,

  "troubleshooting.md": `# Troubleshooting

Common issues and their resolutions. If none of these help, contact support@lumen.example with the \`request_id\` from the failing response.

## "E_AUTH_401" on every request

Most common causes:

1. **Missing \`Bearer\` prefix** — the header must be \`Authorization: Bearer lmn_live_...\`, not \`Authorization: lmn_live_...\`
2. **Revoked key** — check the dashboard under Settings → API keys
3. **Wrong environment** — test keys (\`lmn_test_...\`) work only against the test API at \`https://api-test.lumen.example/v1\`

## "E_AUTH_403" despite a valid key

The key lacks the required scope. Read-only keys cannot create documents. Check the key's scopes in the dashboard — you cannot see the scopes of another member's keys.

## Webhooks not arriving

Verify in this order:

1. Endpoint is publicly reachable (not localhost — use \`ngrok\` for local testing)
2. Endpoint responds with 2xx within 10 seconds
3. Firewall allows requests from Lumen's IP ranges (published at https://lumen.example/ips)
4. Signature verification in your handler isn't rejecting the request (see webhooks.md)
5. The webhook is registered for the event type you expect

Use the dashboard's **Webhooks → Test** button to send a synthetic event.

## "E_VALIDATION" when creating a document

The \`details\` field on the error describes which field failed. Common cases:

- \`recipients[].email\` malformed (missing \`@\` or invalid domain)
- \`expiration_days\` outside 1–365
- \`title\` over 200 characters
- Duplicate \`email\` in recipients (each recipient email must be unique per document)

## Documents stuck in \`sent\` for a long time

Delivery is asynchronous — allow up to 30 seconds. If a document is \`sent\` for more than an hour, the recipient may have unsubscribed (visible in the dashboard) or their email is bouncing (check the recipient's delivery log).

## Pagination loops

If \`GET /v1/documents\` returns the same page twice, ensure you're passing the \`cursor\` from the previous response's \`next_cursor\` field — not \`offset\` (offsets are not supported).

## Timeouts when downloading signed PDFs

Signed PDFs are generated on first download. Large documents (>50 pages) may take 5–10 seconds. Use \`GET /v1/documents/:id/download\` with a \`timeout\` of at least 30 seconds, or subscribe to the \`document.completed\` webhook and download shortly after.
`,

  "faq.md": `# FAQ

## Can I use Lumen in production without a paid plan?

Yes. The Free plan has no time limit, 50 documents per month, and full API access. Upgrading to Pro removes the quota and raises rate limits.

## What file formats can I upload?

PDF only, up to 50 MB per document. For other formats, convert to PDF first. We do not convert on your behalf.

## Do recipients need a Lumen account?

No. Recipients click a signing link in the email and can sign without signing up. The link expires when the document expires.

## Can I customize the signing email?

Pro and Enterprise plans can customize the sender name and email body via \`PATCH /v1/teams/:id/signing-email\`. The \`from\` address must be verified via DNS TXT record.

## How long are signed documents retained?

Indefinitely, unless the document is a draft (drafts can be deleted). Signed documents are legal records and cannot be deleted via the API.

## Are there API client libraries beyond JavaScript and Python?

No. The REST API is fully documented at https://api.lumen.example/v1/docs. Other languages can use HTTP directly.

## Can I test webhooks locally?

Yes, using \`ngrok\` or a similar tunnel. The webhook must be publicly reachable. Test-mode documents emit the same event types as live documents.

## What happens if a recipient's email bounces?

The document remains \`sent\` but the delivery is logged as failed. You can update the recipient email via \`PATCH /v1/documents/:id\` — only in \`sent\` status, before the recipient has interacted. Once the recipient has signed, the email cannot be changed.

## Is there a sandbox environment?

Test keys (\`lmn_test_...\`) operate against \`https://api-test.lumen.example/v1\`, a separate environment with the same API surface. Documents created in test mode never send real emails.

## Where are you hosted?

United States only. See compliance.md for data residency details.
`,

  "sdk-javascript.md": `# JavaScript SDK

The JavaScript SDK (\`@lumen/sdk\`) is the official client for Node.js 20+, Deno, Bun, and modern browsers. The package ships ESM and CommonJS builds with bundled TypeScript types.

## Installation

\`\`\`bash
npm install @lumen/sdk
\`\`\`

## Initialization

\`\`\`js
import { Lumen } from "@lumen/sdk";
const lumen = new Lumen({ apiKey: process.env.LUMEN_API_KEY });
\`\`\`

The client is stateless and safe to reuse across requests. Each \`Lumen\` instance holds one API key; for multi-tenant applications, instantiate per tenant.

## Resources

The client exposes resources matching the REST API: \`lumen.documents\`, \`lumen.templates\`, \`lumen.teams\`, \`lumen.webhooks\`, \`lumen.billing\`. Resource methods return Promises. All requests are retried once on network failure; HTTP errors are thrown as \`LumenError\` with \`code\`, \`message\`, and \`status\`.

## Error handling

\`\`\`js
import { LumenError } from "@lumen/sdk";

try {
  await lumen.documents.create({...});
} catch (err) {
  if (err instanceof LumenError && err.code === "E_VALIDATION") {
    console.error(err.details);
  } else {
    throw err;
  }
}
\`\`\`

## Configuration

| Option | Default | Notes |
|---|---|---|
| \`apiKey\` | required | API key with appropriate scope |
| \`baseUrl\` | \`https://api.lumen.example/v1\` | Override for test environment |
| \`timeout\` | 30000ms | Per-request timeout |
| \`maxRetries\` | 1 | Network-error retries (HTTP 429 is not retried) |

## TypeScript

Types are bundled — no \`@types\` package needed. The \`Lumen\` class is generic over a resource map; use \`defineResources<T>()\` for custom endpoint typing.

## Test environment

Point at the test API by overriding \`baseUrl\`:

\`\`\`js
const lumen = new Lumen({
  apiKey: process.env.LUMEN_TEST_KEY,
  baseUrl: "https://api-test.lumen.example/v1",
});
\`\`\`

Test-mode documents never send real email — useful for integration tests.
`,

  "sdk-python.md": `# Python SDK

The Python SDK (\`lumen-python\`) targets Python 3.9+ and mirrors the JavaScript SDK's resource structure.

## Installation

\`\`\`bash
pip install lumen-python
\`\`\`

## Initialization

\`\`\`python
import os
from lumen import Lumen

client = Lumen(api_key=os.environ["LUMEN_API_KEY"])
\`\`\`

The client is thread-safe and reusable across threads. For asyncio, use \`lumen.AsyncLumen\` — the async client mirrors the sync surface.

## Resources

All resource methods accept keyword arguments matching the REST API's request body. Responses are plain Python dataclasses; serialize with \`dataclasses.asdict()\`.

## Async client

\`\`\`python
import asyncio
from lumen import AsyncLumen

async def main():
    client = AsyncLumen(api_key=os.environ["LUMEN_API_KEY"])
    doc = await client.documents.create(...)
    print(doc.id, doc.status)

asyncio.run(main())
\`\`\`

## Error handling

\`\`\`python
from lumen import LumenError

try:
    client.documents.create(...)
except LumenError as err:
    if err.code == "E_VALIDATION":
        print(err.details)
    else:
        raise
\`\`\`

## Configuration

| Option | Default | Notes |
|---|---|---|
| \`api_key\` | required | API key with appropriate scope |
| \`base_url\` | \`https://api.lumen.example/v1\` | Override for test environment |
| \`timeout\` | 30.0 (seconds) | Per-request timeout |
| \`max_retries\` | 1 | Network-error retries |

## Types

Pydantic models are used for request and response types. Set \`Lumen(validate=True)\` to enable strict response validation (slower but catches server bugs). Default is \`validate=False\` for performance.
`,

  "changelog.md": `# Changelog

All notable changes to the Lumen API. Dates are ISO 8601. Breaking changes are marked **BREAKING**.

## 2025-09-15 — v2 current

- **BREAKING:** \`POST /v1/documents\` now returns HTTP 202 (was 201). The document is created immediately but status is \`sent\` (was \`draft\`).
- Added: \`PATCH /v1/teams/:id/signing-email\` for custom signing email (Pro+).
- Added: \`GET /v1/audit-logs\` (Enterprise only).
- Added: \`document.expired\` webhook event (previously only visible via polling).
- Changed: \`expiration_days\` default from 14 to 30 (backwards compatible — only affects new documents without explicit value).

## 2025-06-01

- Added: templates API (\`/v1/templates\`). Templates reuse document definitions.
- Added: \`POST /v1/templates/:id/send\` shortcut.
- Fixed: \`E_RATE_LIMIT\` responses now include \`retry_after\` on all plan tiers (was missing on Free).

## 2025-03-15

- Added: OAuth 2.0 authorization code flow for third-party integrations (see authentication.md).
- Added: \`E_AUTH_429\` error for auth attempt flooding.
- Changed: API keys now show their last-used timestamp in the dashboard (Pro+).

## 2025-01-10

- **BREAKING:** Removed \`/v1/legacy/auth\` endpoint. Use \`/v1/auth\` (documented under authentication.md).
- Added: idempotency key support on \`POST\` endpoints.

## 2024-12-01

- Initial v1 release.
`,

  "migration.md": `# Migration guide

This guide covers migrating from API v1 (deprecated 2025-09-15) to v2. v1 remains available until 2026-03-15; after that date, v1 endpoints return HTTP 410.

## What changed

The core API surface is identical. Breaking changes:

1. **Document status on create** — v1 returned HTTP 201 with \`status: "draft"\`. v2 returns HTTP 202 with \`status: "sent"\`. If your code polls for \`draft → sent\`, update to treat \`sent\` as immediate.
2. **\`expiration_days\` default** — v1 default 14, v2 default 30. Set explicitly if you depend on 14.
3. **\`/v1/legacy/auth\` removed** — use \`/v1/auth\`.

## Step 1: Update SDK versions

JavaScript: \`npm install @lumen/sdk@^2.0.0\`
Python: \`pip install lumen-python@^2.0.0\`

Both SDKs auto-negotiate the API version via the \`X-Lumen-API-Version\` header (defaults to \`v2\`).

## Step 2: Audit your document creation flow

Search your codebase for \`POST /v1/documents\` or \`lumen.documents.create()\`. The v2 response has HTTP 202 (not 201), \`status: "sent"\` (not \`"draft"\`), and no \`draft_id\` field (removed; \`id\` is always final). If you rely on a "draft" state, use templates (see templates.md) or set \`expiration_days\` explicitly and wait for the first webhook.

## Step 3: Check expiration handling

If you create documents without an explicit \`expiration_days\` and rely on the 14-day default, add the field explicitly.

## Step 4: Update auth endpoint references

Replace \`/v1/legacy/auth\` with \`/v1/auth\`. Response shape is identical.

## Step 5: Remove deprecated v1-only features

The following v1 features do not exist in v2: \`GET /v1/legacy/documents\` (prefix mismatch), \`POST /v1/legacy/send\` (use \`POST /v1/documents\`).

## Testing

Use the test environment (\`api-test.lumen.example\`) before migrating production. Test-mode documents are fully isolated from production.

## Rollback

Within 30 days of upgrading your SDK, you can pin back to \`@lumen/sdk@1.x\` or \`lumen-python@1.x\`. After 2026-03-15, v1 endpoints are permanently gone.
`,

  "integrations.md": `# Integrations

Lumen integrates with common workflow tools and receives push notifications via webhooks. All integrations are configured in the dashboard under **Settings → Integrations**.

## Available integrations

| Integration | Direction | Plan |
|---|---|---|
| Zapier | Lumen → Zapier | Pro, Enterprise |
| Slack | Lumen → Slack | Pro, Enterprise |
| Microsoft Teams | Lumen → Teams | Pro, Enterprise |
| Google Drive | Lumen → Drive | Pro, Enterprise |
| Salesforce | Lumen → Salesforce | Enterprise |

Integrations deliver events from Lumen to the target service. To receive events in your own infrastructure, use webhooks (see webhooks.md).

## Zapier

Zapier integration exposes Lumen events as Zapier triggers. Supported triggers: \`document.sent\`, \`document.completed\`, \`document.declined\`, \`document.expired\`. Setup: connect your Lumen account in Zapier, then select "Lumen" as a trigger app. Authentication is via API key — use an \`admin\`-scoped key for full access.

## Slack

Slack integration posts a message to a channel when a document is completed, declined, or expires. Configure per-channel in Settings → Integrations → Slack. Message formatting is fixed; for custom formatting, use webhooks with a Slack incoming webhook.

## Microsoft Teams

Same events and configuration as Slack, targeting Teams channels. Setup requires Teams admin approval in most organizations.

## Google Drive

When a document completes, Drive integration uploads the signed PDF to a configured Drive folder. Folder must be shared with the Lumen service account — the OAuth flow guides this.

## Salesforce

Enterprise-only. Syncs completed documents to Salesforce records by matching recipient email to a Contact or Lead. Field mapping is configurable in the dashboard.

## Custom integrations

For anything else, use webhooks. The webhook payload includes \`document_id\` — fetch the full document via \`GET /v1/documents/:id\` when needed. This pattern works for any HTTP-speaking system, avoiding vendor-specific integrations entirely.

## API-only integrations

The REST API (documented at https://api.lumen.example/v1/docs) is the source of truth. All SDKs, integrations, and webhooks are built on it. If a system speaks HTTP, it can integrate with Lumen via REST.
`,
};

await mkdir("data/corpus", { recursive: true });

let written = 0;
for (const [name, content] of Object.entries(files)) {
  await writeFile(`data/corpus/${name}`, content, "utf8");
  console.log(`wrote data/corpus/${name}  (${content.length} chars)`);
  written++;
}

console.log(`\ndone: ${written} files written`);
