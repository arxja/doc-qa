# Lumen API

Lumen is a document-signing API. You create a document, send it for signature, and receive webhooks as recipients sign.

## Overview

The API is REST over HTTPS. All requests go to `https://api.lumen.example/v1`. Requests and responses are JSON. Every response includes a `request_id` header you can quote in support tickets.

## Core concepts

- **Document** — a PDF plus metadata (title, recipients, expiration).
- **Recipient** — a person asked to sign, view, or approve a document. Each recipient has a role: `signer`, `viewer`, or `approver`.
- **Envelope** — the container that tracks a document through its lifecycle.
- **Event** — a webhook payload emitted when something changes.

## Versioning

The path prefix (`/v1`) is the only versioning mechanism. Breaking changes ship under a new prefix; additive changes (new optional fields, new event types) ship in-place.
