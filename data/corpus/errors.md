# Errors

Errors return a JSON body with `code`, `message`, and `request_id`. HTTP status matches the error family (4xx client, 5xx server). You should not retry 4xx errors except `E_RATE_LIMIT`.

## Code format

Codes follow `E_<FAMILY>_<HTTP_STATUS>` or a specific suffix, for example `E_DOC_NOT_FOUND`. The `code` is stable; the `message` may change.

## Common errors

| Code | HTTP | Meaning |
|---|---|---|
| `E_AUTH_401` | 401 | Invalid or revoked credentials |
| `E_AUTH_403` | 403 | Missing scope |
| `E_DOC_NOT_FOUND` | 404 | Document does not exist or is not visible to this team |
| `E_VALIDATION` | 422 | Request body failed schema validation |
| `E_RATE_LIMIT` | 429 | Rate limit exceeded (see rate-limits.md) |
| `E_INTERNAL` | 500 | Unexpected server error; safe to retry with backoff |

## Negation cases

A `viewer` recipient **cannot** delete a document. Deletion requires the `admin` scope and is only permitted on documents in `draft` state. A `signer` **cannot** change recipient roles after sending. If you need either capability, you must use an `admin`-scoped key.

## Idempotency

POST requests accept an `Idempotency-Key` header. Replaying a request with the same key within 24 hours returns the original response without re-executing the side effect.
