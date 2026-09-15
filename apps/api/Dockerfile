FROM rust:1.98-bookworm AS builder

WORKDIR /app
COPY apps/api/Cargo.toml apps/api/Cargo.lock ./
COPY apps/api/migrations ./migrations
COPY apps/api/src ./src
RUN cargo build --locked --release --bin hub-william-backend

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/hub-william-backend /usr/local/bin/hub-william-backend

ENV PORT=8080
EXPOSE 8080
CMD ["hub-william-backend"]
