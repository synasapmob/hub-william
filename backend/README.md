# Backend

Rust control-plane and gateway service for Hub William. The current bootstrap
exposes only runtime health and generated OpenAPI documentation; pool, payment,
database, gateway, SePay, and Telegram behavior will be added in later changes.

```bash
cargo run --manifest-path backend/Cargo.toml
```

- Health: `http://localhost:8080/health`
- OpenAPI: `http://localhost:8080/api-docs/openapi.json`
- Swagger UI: `http://localhost:8080/docs`

`PORT` defaults to `8080` locally and is supplied by the deployment runtime in
production. Keep secrets in the runtime secret store; never commit a populated
environment file.
