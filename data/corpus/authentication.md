# Authentication

Every request must carry an API key in the `Authorization` header as `Bearer <key>`. Keys are scoped to a single team.

## API keys

Create keys in the dashboard under **Settings → API keys**. A key looks like `lmn_live_...` or `lmn_test_...`. Test keys operate against test documents and never send real email.

Keys have three permission scopes:

- `read` — can fetch documents, envelopes, and events.
- `write` — can create and modify documents.
- `admin` — can manage team members and rotate keys.

A key without the required scope returns `E_AUTH_403`.

### Rotation

Rotate keys every 90 days. Rotation is zero-downtime: create the new key, deploy it, then revoke the old one. Revoked keys return `E_AUTH_401` immediately.

## OAuth 2.0

For third-party integrations, use OAuth 2.0 authorization code flow. The authorize endpoint is `https://api.lumen.example/oauth/authorize`. Tokens expire after 3600 seconds; refresh tokens are valid for 30 days.

## Authentication errors

| Code | Meaning |
|---|---|
| `E_AUTH_401` | Missing, malformed, or revoked key |
| `E_AUTH_403` | Key lacks the required scope |
| `E_AUTH_429` | Too many auth attempts from this IP |
