# Backend

Rust control-plane and streaming gateway service for Hub William. It owns
username/password registration, rotating PostgreSQL-backed browser sessions,
ChatGPT/Claude/Grok authorization, encrypted provider credentials, user-scoped
gateway keys, runtime health, and generated OpenAPI documentation. Pool
persistence and join requests are live; provider usage ingestion and Telegram
commerce remain later changes.

```bash
cargo run --manifest-path backend/Cargo.toml
```

- Health: `http://localhost:8080/health`
- OpenAPI: `http://localhost:8080/api-docs/openapi.json`
- Swagger UI: `http://localhost:8080/docs`

Copy `.env.example` into your local secret manager or run through Railway so
`DATABASE_URL` is available. The binary applies SQLx migrations before it starts
listening. `PROVIDER_CREDENTIAL_ENCRYPTION_KEY` must be an unpadded URL-safe
base64 encoding of exactly 32 random bytes. `PORT` defaults to `8080`;
`FRONTEND_ORIGIN` restricts credentialed browser requests and
`COOKIE_SECURE=true` enables secure cookies for production. Keep all
populated values in the runtime secret store.

## Live routes

- `/auth/*`: five-hour access session and rotating seven-day refresh session.
- `/agent-connections/*`: official provider authorization start, poll, callback,
  disconnect, and refresh-on-read lifecycle.
- `/gateway-keys`: create-once, list metadata, and revoke operations.
- `/gateway/openai/v1/responses`: Codex/OpenAI Responses streaming gateway.
- `/gateway/claude/v1/messages`: Claude Messages streaming gateway.
- `/gateway/grok/v1/*`: Grok OpenAI-compatible gateway.

Gateway keys are shown once and stored only as hashes. A key can route through
the user's own connected provider or an account pool where their join request
is accepted; an owned account wins, otherwise the latest accepted membership
is selected. Provider token payloads are AES-256-GCM encrypted. Do not log
request authorization headers, OAuth codes, device codes, callback URLs, or
provider response bodies.
