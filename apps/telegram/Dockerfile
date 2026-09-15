FROM rust:1.98-bookworm AS builder

WORKDIR /app
COPY apps/telegram/Cargo.toml apps/telegram/Cargo.lock ./
COPY apps/telegram/assets ./assets
COPY apps/telegram/src ./src
RUN cargo build --locked --release --bin hub-william-telegram

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/hub-william-telegram /usr/local/bin/hub-william-telegram

ENV PORT=8090
EXPOSE 8090
CMD ["hub-william-telegram"]
