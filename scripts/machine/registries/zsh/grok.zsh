# >>> grok installer >>>
export PATH="$HOME/.grok/bin:$PATH"
fpath=(~/.grok/completions/zsh $fpath)
autoload -Uz compinit && compinit -C
# <<< grok installer <<<

# Hub William — Grok Build usage telemetry.
#
# Each launch gets its own run id. It rides in the OTLP endpoint path, which is
# the only way a Grok export can be tied to the folder it came from.
#
# HUB_WILLIAM_KEY is the gateway key. It lives in ~/.zsh/secrets.zsh, which is
# gitignored. Without it grok still runs, just without telemetry — a missing
# key should not cost you the CLI.

: "${HUB_WILLIAM_OTLP_BASE:=https://dvepnvntttvstbtoypoy.supabase.co/functions/v1}"

grok() {
  if [[ -z "$HUB_WILLIAM_KEY" ]]; then
    command grok "$@"
    return
  fi

  local run_id
  run_id="$(uuidgen)"

  GROK_EXTERNAL_OTEL=1 \
  OTEL_LOGS_EXPORTER=otlp \
  OTEL_METRICS_EXPORTER=none \
  OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
  OTEL_EXPORTER_OTLP_ENDPOINT="$HUB_WILLIAM_OTLP_BASE/grok-otel/r/$run_id" \
  OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer $HUB_WILLIAM_KEY" \
  HUB_WILLIAM_RUN_ID="$run_id" \
  HUB_WILLIAM_KEY="$HUB_WILLIAM_KEY" \
  command grok "$@"
}
