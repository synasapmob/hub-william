#!/usr/bin/env bash
set -euo pipefail

: "${TELEGRAM_BOT_TOKEN:?Set TELEGRAM_BOT_TOKEN in this shell; do not commit it.}"
: "${TELEGRAM_WEBHOOK_URL:?Set TELEGRAM_WEBHOOK_URL to the public apps/telegram Railway URL.}"
: "${TELEGRAM_WEBHOOK_SECRET:?Set TELEGRAM_WEBHOOK_SECRET to the secret configured in apps/telegram.}"

webhook_url="${TELEGRAM_WEBHOOK_URL%/}/webhook"
api_url="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

curl --fail-with-body --silent --show-error \
    --request POST "${api_url}/setMyCommands" \
    --data-urlencode 'commands=[{"command":"start","description":"Start Hub William"},{"command":"menu","description":"Open the shop"},{"command":"catalog","description":"Browse the catalogue"},{"command":"orders","description":"View your orders"},{"command":"lang","description":"Change language"},{"command":"help","description":"Get support"},{"command":"status","description":"Telegram status"}]'

curl --fail-with-body --silent --show-error \
    --request POST "${api_url}/setWebhook" \
    --data-urlencode "url=${webhook_url}" \
    --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
    --data-urlencode 'allowed_updates=["message","callback_query"]'

printf '\nTelegram webhook configured for %s\n' "$webhook_url"
