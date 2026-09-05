#!/usr/bin/env bash
# Ask the Codex gateway one question and print one answer.
#
# The ChatGPT backend rejects {"stream": false} outright ("Stream must be set to
# true"), so a single-shot JSON reply is not available — the stream is collapsed
# here instead. Text comes from response.output_text.done; response.completed
# carries only usage on this endpoint, its output array is always empty.
#
#   ./scripts/ask-gateway.sh                         # prompts for question, then key
#   ./scripts/ask-gateway.sh "your question"         # also supported
#
# Env:
#   HUB_GATEWAY_URL  optional, defaults to the deployed function
#   HUB_MODEL        optional, defaults to gpt-5.6-sol

set -euo pipefail

GATEWAY="${HUB_GATEWAY_URL:-https://dvepnvntttvstbtoypoy.supabase.co/functions/v1/codex-gateway/v1}"
MODEL="${HUB_MODEL:-gpt-5.6-sol}"
PROMPT=""
OTP_KEY=""
stream=""
headers=""

# A gateway key is treated as a one-run OTP here. Never accept an inherited
# or exported copy: every invocation must ask for it again.
unset HUB_WILLIAM_KEY

cleanup() {
  OTP_KEY=""
  unset OTP_KEY
  [ -z "$stream" ] || rm -f -- "$stream"
  [ -z "$headers" ] || rm -f -- "$headers"
}
trap cleanup EXIT

# Prefer the controlling terminal so the two prompts still work if stdin is
# redirected. With no terminal (for example in a pipe), fall back to stdin.
if { exec 3< /dev/tty; } 2>/dev/null; then
  if [ "$#" -gt 0 ]; then
    PROMPT="$*"
  elif ! IFS= read -rp "Question: " PROMPT <&3; then
    echo "could not read question" >&2
    exit 1
  fi

  if ! IFS= read -rsp "Gateway OTP key (not saved): " OTP_KEY <&3; then
    printf '\n' >&2
    echo "could not read key" >&2
    exit 1
  fi
  exec 3<&-
else
  if [ "$#" -gt 0 ]; then
    PROMPT="$*"
  elif ! IFS= read -rp "Question: " PROMPT; then
    echo "could not read question" >&2
    exit 1
  fi

  if ! IFS= read -rsp "Gateway OTP key (not saved): " OTP_KEY; then
    printf '\n' >&2
    echo "could not read key" >&2
    exit 1
  fi
fi

# -s swallowed the newline typed after the hidden key.
printf '\n' >&2

if [ -z "$PROMPT" ]; then
  echo "no question entered" >&2
  exit 1
fi

if [ -z "$OTP_KEY" ]; then
  echo "no key entered" >&2
  exit 1
fi

# Catch a mistyped, truncated, or whitespace-padded paste before making the
# request. Generated gateway keys contain exactly 43 base64url characters.
if [[ ! "$OTP_KEY" =~ ^hw_sk_[A-Za-z0-9_-]{43}$ ]]; then
  echo "invalid gateway key; paste the complete hw_sk_... value exactly" >&2
  exit 1
fi

stream=$(mktemp)
headers=$(mktemp)

body=$(jq -n --arg model "$MODEL" --arg text "$PROMPT" '{
  model: $model,
  input: [{type:"message", role:"user", content:[{type:"input_text", text:$text}]}],
  stream: true,
  store: false
}')

# The Authorization header goes in through a config file on stdin, not on the
# command line: anything in argv is visible to every other process via ps.
status=$(printf 'header = "Authorization: Bearer %s"\n' "$OTP_KEY" \
  | curl -N -s -K - -o "$stream" -D "$headers" -w '%{http_code}' \
      "$GATEWAY/responses" \
      -H "Content-Type: application/json" \
      -H "Accept: text/event-stream" \
      -d "$body")

# curl has consumed the credential; do not retain it while parsing the reply.
OTP_KEY=""
unset OTP_KEY

if [ "$status" != "200" ]; then
  echo "gateway returned HTTP $status" >&2
  cat "$stream" >&2
  exit 1
fi

grep '"type":"response.output_text.done"' "$stream" \
  | sed 's/^data: //' \
  | jq -r '.text'

# Which account served the turn, and how full it is now. These ride on the
# response headers the gateway passes back from upstream.
plan=$(grep -i '^x-codex-plan-type:' "$headers" | tr -d '\r' | awk '{print $2}')
used=$(grep -i '^x-codex-primary-used-percent:' "$headers" | tr -d '\r' | awk '{print $2}')
window=$(grep -i '^x-codex-primary-window-minutes:' "$headers" | tr -d '\r' | awk '{print $2}')
tokens=$(grep '"type":"response.completed"' "$stream" | sed 's/^data: //' \
  | jq -r '.response.usage.total_tokens // "?"')

echo "---"
echo "plan=${plan:-?}  quota_used=${used:-?}%  window=${window:-?}min  tokens=${tokens}"
