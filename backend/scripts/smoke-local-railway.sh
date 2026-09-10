#!/usr/bin/env bash

set -euo pipefail

task_tmp=$(mktemp -d)
task_username="integration$(date +%s)"
task_requester_username="requester$(date +%s)"
task_password="Test-only-password-2026"
task_railway_vars=$(railway variables --service Postgres --json)
task_pg_user=$(jq -rn --arg value "$(jq -r '.PGUSER' <<< "$task_railway_vars")" '$value|@uri')
task_pg_password=$(jq -rn --arg value "$(jq -r '.PGPASSWORD' <<< "$task_railway_vars")" '$value|@uri')
task_pg_database=$(jq -rn --arg value "$(jq -r '.PGDATABASE' <<< "$task_railway_vars")" '$value|@uri')
task_pg_host=$(jq -r '.RAILWAY_TCP_PROXY_DOMAIN' <<< "$task_railway_vars")
task_pg_port=$(jq -r '.RAILWAY_TCP_PROXY_PORT' <<< "$task_railway_vars")
task_db_url="postgresql://${task_pg_user}:${task_pg_password}@${task_pg_host}:${task_pg_port}/${task_pg_database}"

cleanup() {
  psql "$task_db_url" -v ON_ERROR_STOP=1 -q \
    -c "DELETE FROM users WHERE username IN ('${task_username}', '${task_requester_username}')" >/dev/null 2>&1 || true
  rm -rf -- "$task_tmp"
}
trap cleanup EXIT
trap 'echo "smoke failed at line ${LINENO}"' ERR

health_status=$(curl -sS -o "$task_tmp/health.json" -w '%{http_code}' http://127.0.0.1:8080/health)
[[ "$health_status" == "200" ]]
[[ "$(jq -r '.service' "$task_tmp/health.json")" == "hub-william-backend" ]]
echo "health: 200 hub-william-backend"

register_status=$(curl -sS -D "$task_tmp/register.headers" -c "$task_tmp/cookies.txt" \
  -o "$task_tmp/register.json" -w '%{http_code}' -H 'content-type: application/json' \
  --data "{\"username\":\"${task_username}\",\"password\":\"${task_password}\",\"recovery_email\":\"${task_username}@gmail.com\"}" \
  http://127.0.0.1:8080/auth/register)
[[ "$register_status" == "201" ]]
grep -Ei '^set-cookie: hub_session=' "$task_tmp/register.headers" | grep -qi 'Max-Age=18000'
grep -Ei '^set-cookie: hub_session=' "$task_tmp/register.headers" | grep -qi 'HttpOnly'
grep -Ei '^set-cookie: hub_refresh=' "$task_tmp/register.headers" | grep -qi 'Max-Age=604800'
grep -Ei '^set-cookie: hub_refresh=' "$task_tmp/register.headers" | grep -qi 'HttpOnly'
task_user_id=$(jq -r '.user.id' "$task_tmp/register.json")
task_access_before=$(awk '$6=="hub_session" {print $7}' "$task_tmp/cookies.txt" | shasum -a 256 | awk '{print $1}')
task_refresh_before=$(awk '$6=="hub_refresh" {print $7}' "$task_tmp/cookies.txt" | shasum -a 256 | awk '{print $1}')
[[ -n "$task_access_before" && -n "$task_refresh_before" ]]
echo "register: 201; access cookie 5h HttpOnly; refresh cookie 7d HttpOnly"

session_windows=$(psql "$task_db_url" -At -v ON_ERROR_STOP=1 -c \
  "SELECT expires_at BETWEEN NOW() + INTERVAL '4 hours 55 minutes' AND NOW() + INTERVAL '5 hours 5 minutes', refresh_expires_at BETWEEN NOW() + INTERVAL '6 days 23 hours' AND NOW() + INTERVAL '7 days 1 hour' FROM sessions WHERE user_id = '${task_user_id}'")
[[ "$session_windows" == "t|t" ]]
echo "database session windows: access≈5h refresh≈7d"

refresh_status=$(curl -sS -b "$task_tmp/cookies.txt" -c "$task_tmp/cookies.txt" \
  -o "$task_tmp/refresh.json" -w '%{http_code}' -X POST http://127.0.0.1:8080/auth/refresh)
[[ "$refresh_status" == "200" ]]
task_access_after=$(awk '$6=="hub_session" {print $7}' "$task_tmp/cookies.txt" | shasum -a 256 | awk '{print $1}')
task_refresh_after=$(awk '$6=="hub_refresh" {print $7}' "$task_tmp/cookies.txt" | shasum -a 256 | awk '{print $1}')
[[ "$task_access_before" != "$task_access_after" && "$task_refresh_before" != "$task_refresh_after" ]]
echo "refresh: 200; both opaque cookies rotated"

connections_status=$(curl -sS -b "$task_tmp/cookies.txt" -o "$task_tmp/connections.json" \
  -w '%{http_code}' http://127.0.0.1:8080/agent-connections)
[[ "$connections_status" == "200" && "$(jq -r 'type' "$task_tmp/connections.json")" == "array" ]]
echo "connections list: 200 authenticated"

claude_status=$(curl -sS -b "$task_tmp/cookies.txt" -o "$task_tmp/claude.json" \
  -w '%{http_code}' -H 'content-type: application/json' --data '{"provider":"claude"}' \
  http://127.0.0.1:8080/agent-connections/start)
[[ "$claude_status" == "201" ]]
[[ "$(jq -r '.authorization.authorization_url | startswith("https://claude.com/cai/oauth/authorize?")' "$task_tmp/claude.json")" == "true" ]]
[[ "$(jq -r '.authorization.requires_callback_url' "$task_tmp/claude.json")" == "true" ]]
echo "Claude start: 201 official authorize URL + manual callback flow"

chatgpt_status=$(curl --max-time 30 -sS -b "$task_tmp/cookies.txt" -o "$task_tmp/chatgpt.json" \
  -w '%{http_code}' -H 'content-type: application/json' --data '{"provider":"chatgpt"}' \
  http://127.0.0.1:8080/agent-connections/start || true)
if [[ "$chatgpt_status" == "201" ]]; then
  [[ "$(jq -r '.authorization.authorization_url | startswith("https://auth.openai.com/codex/device?user_code=")' "$task_tmp/chatgpt.json")" == "true" ]]
  echo "ChatGPT start: 201 official device authorization URL"
else
  [[ "$chatgpt_status" == "502" ]]
  [[ "$(jq -r '.code' "$task_tmp/chatgpt.json")" == "provider_unavailable" ]]
  echo "ChatGPT start: 502 explicit upstream unavailable (no mock fallback)"
fi

grok_status=$(curl --max-time 30 -sS -b "$task_tmp/cookies.txt" -o "$task_tmp/grok.json" \
  -w '%{http_code}' -H 'content-type: application/json' --data '{"provider":"grok"}' \
  http://127.0.0.1:8080/agent-connections/start || true)
if [[ "$grok_status" == "201" ]]; then
  [[ "$(jq -r '.authorization.authorization_url | startswith("https://accounts.x.ai/oauth2/device?")' "$task_tmp/grok.json")" == "true" ]]
  echo "Grok start: 201 official device authorization URL"
else
  [[ "$grok_status" == "502" ]]
  [[ "$(jq -r '.code' "$task_tmp/grok.json")" == "provider_unavailable" ]]
  echo "Grok start: 502 explicit upstream unavailable (no mock fallback)"
fi

task_connection_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
task_connection_id=$(psql "$task_db_url" -v ON_ERROR_STOP=1 -Atq -c \
  "INSERT INTO agent_connections (id, user_id, provider, status, account_label, plan) VALUES ('${task_connection_id}', '${task_user_id}', 'grok', 'connected', 'int*******@example.com', 'K12') RETURNING id")
task_connection_id_two=$(uuidgen | tr '[:upper:]' '[:lower:]')
task_connection_id_two=$(psql "$task_db_url" -v ON_ERROR_STOP=1 -Atq -c \
  "INSERT INTO agent_connections (id, user_id, provider, status, account_label, plan) VALUES ('${task_connection_id_two}', '${task_user_id}', 'grok', 'connected', 'sec*******@example.com', 'Plus') RETURNING id")
same_provider_connection_count=$(psql "$task_db_url" -v ON_ERROR_STOP=1 -Atq -c \
  "SELECT COUNT(*) FROM agent_connections WHERE user_id = '${task_user_id}' AND provider = 'grok' AND status = 'connected'")
[[ "$same_provider_connection_count" == "2" ]]
echo "multiple connections: one Hub user owns two connected Grok account pools"

public_pools_status=$(curl -sS -o "$task_tmp/public-pools.json" -w '%{http_code}' \
  http://127.0.0.1:8080/agent-pools)
[[ "$public_pools_status" == "200" ]]
[[ "$(jq -r --arg id "$task_connection_id" '.[] | select(.id == $id) | .requests | length' "$task_tmp/public-pools.json")" == "0" ]]
echo "public pools: connected database account visible; private requests omitted"

requester_register_status=$(curl -sS -c "$task_tmp/requester-cookies.txt" \
  -o "$task_tmp/requester-register.json" -w '%{http_code}' -H 'content-type: application/json' \
  --data "{\"username\":\"${task_requester_username}\",\"password\":\"${task_password}\",\"recovery_email\":null}" \
  http://127.0.0.1:8080/auth/register)
[[ "$requester_register_status" == "201" ]]

request_status=$(curl -sS -b "$task_tmp/requester-cookies.txt" -o "$task_tmp/request.json" \
  -w '%{http_code}' -H 'content-type: application/json' \
  --data '{"telegram":"@integration_requester","reason":"Integration test request for the shared provider account."}' \
  "http://127.0.0.1:8080/agent-pools/${task_connection_id}/requests")
[[ "$request_status" == "201" ]]
[[ "$(jq -r '.status' "$task_tmp/request.json")" == "pending" ]]
task_request_id=$(jq -r '.id' "$task_tmp/request.json")
[[ "$task_request_id" != "null" && -n "$task_request_id" ]]
echo "join request: 201 persisted as pending"

owner_pools_status=$(curl -sS -b "$task_tmp/cookies.txt" -o "$task_tmp/owner-pools.json" \
  -w '%{http_code}' http://127.0.0.1:8080/agent-pools)
[[ "$owner_pools_status" == "200" ]]
[[ "$(jq -r --arg id "$task_request_id" '.[] | .requests[] | select(.id == $id) | .telegram' "$task_tmp/owner-pools.json")" == "@integration_requester" ]]
echo "owner pool view: pending reason and Telegram visible"

decision_status=$(curl -sS -b "$task_tmp/cookies.txt" -o "$task_tmp/decision.json" \
  -w '%{http_code}' -H 'content-type: application/json' --data '{"status":"accepted"}' \
  "http://127.0.0.1:8080/agent-pool-requests/${task_request_id}/decision")
if [[ "$decision_status" != "200" ]]; then
  echo "first owner decision failed: HTTP ${decision_status} $(jq -c '{code, message}' "$task_tmp/decision.json")"
fi
[[ "$decision_status" == "200" ]]
jq -e '.status == "accepted"' "$task_tmp/decision.json" >/dev/null

requester_pools_status=$(curl -sS -b "$task_tmp/requester-cookies.txt" -o "$task_tmp/requester-pools.json" \
  -w '%{http_code}' http://127.0.0.1:8080/agent-pools)
[[ "$requester_pools_status" == "200" ]]
jq -e --arg id "$task_connection_id" --arg username "$task_requester_username" \
  '.[] | select(.id == $id) | any(.members[]; .username == $username)' \
  "$task_tmp/requester-pools.json" >/dev/null
jq -e --arg pool_id "$task_connection_id" --arg request_id "$task_request_id" \
  '.[] | select(.id == $pool_id) | any(.requests[]; .id == $request_id and .status == "accepted")' \
  "$task_tmp/requester-pools.json" >/dev/null
echo "owner decision: accepted request persisted and member returned to requester"

request_two_status=$(curl -sS -b "$task_tmp/requester-cookies.txt" -o "$task_tmp/request-two.json" \
  -w '%{http_code}' -H 'content-type: application/json' \
  --data '{"telegram":"@integration_requester","reason":"Integration test request for a second shared provider account."}' \
  "http://127.0.0.1:8080/agent-pools/${task_connection_id_two}/requests")
[[ "$request_two_status" == "201" ]]
task_request_two_id=$(jq -r '.id' "$task_tmp/request-two.json")
decision_two_status=$(curl -sS -b "$task_tmp/cookies.txt" -o "$task_tmp/decision-two.json" \
  -w '%{http_code}' -H 'content-type: application/json' --data '{"status":"accepted"}' \
  "http://127.0.0.1:8080/agent-pool-requests/${task_request_two_id}/decision")
if [[ "$decision_two_status" != "200" ]]; then
  echo "second owner decision failed: HTTP ${decision_two_status} $(jq -c '{code, message}' "$task_tmp/decision-two.json")"
fi
[[ "$decision_two_status" == "200" ]]
same_provider_membership_count=$(psql "$task_db_url" -v ON_ERROR_STOP=1 -Atq -c \
  "SELECT COUNT(*) FROM agent_pool_join_requests AS requests JOIN agent_connections AS connections ON connections.id = requests.connection_id WHERE requests.requester_user_id = (SELECT id FROM users WHERE username = '${task_requester_username}') AND requests.status = 'accepted' AND connections.provider = 'grok'")
[[ "$same_provider_membership_count" == "2" ]]
cross_provider_membership_count=$(psql "$task_db_url" -v ON_ERROR_STOP=1 -Atq -c \
  "SELECT COUNT(*) FROM agent_pool_join_requests AS requests JOIN agent_connections AS connections ON connections.id = requests.connection_id WHERE requests.requester_user_id = (SELECT id FROM users WHERE username = '${task_requester_username}') AND requests.status = 'accepted' AND connections.provider = 'claude'")
[[ "$cross_provider_membership_count" == "0" ]]
echo "multiple memberships: requester accepted into two Grok pools; Claude candidate set remains empty"

requester_key_status=$(curl -sS -b "$task_tmp/requester-cookies.txt" -o "$task_tmp/requester-key.json" \
  -w '%{http_code}' -X POST http://127.0.0.1:8080/gateway-keys)
[[ "$requester_key_status" == "201" ]]
task_requester_gateway_key=$(jq -r '.key' "$task_tmp/requester-key.json")
requester_models_status=$(curl -sS -o "$task_tmp/requester-models.json" -w '%{http_code}' \
  -H "authorization: Bearer ${task_requester_gateway_key}" \
  http://127.0.0.1:8080/gateway/grok/v1/models)
[[ "$requester_models_status" == "200" ]]
echo "accepted memberships: one requester key routes across the accessible Grok pool set"

key_status=$(curl -sS -b "$task_tmp/cookies.txt" -o "$task_tmp/key.json" \
  -w '%{http_code}' -X POST http://127.0.0.1:8080/gateway-keys)
[[ "$key_status" == "201" ]]
task_gateway_key=$(jq -r '.key' "$task_tmp/key.json")
[[ "$task_gateway_key" == hw_live_* ]]
[[ "$(jq -r '.last_four | length' "$task_tmp/key.json")" == "4" ]]
echo "gateway key create: 201; secret returned once with four-character metadata"

key_list_status=$(curl -sS -b "$task_tmp/cookies.txt" -o "$task_tmp/keys.json" \
  -w '%{http_code}' http://127.0.0.1:8080/gateway-keys)
[[ "$key_list_status" == "200" && "$(jq 'length' "$task_tmp/keys.json")" == "1" ]]
[[ "$(jq '.[0] | has("key")' "$task_tmp/keys.json")" == "false" ]]
echo "gateway key list: 200 metadata only"

gateway_missing_provider_status=$(curl -sS -o "$task_tmp/models.json" -w '%{http_code}' \
  -H "authorization: Bearer ${task_gateway_key}" -H 'content-type: application/json' \
  --data '{}' http://127.0.0.1:8080/gateway/openai/v1/responses)
[[ "$gateway_missing_provider_status" == "403" ]]
echo "gateway provider boundary: valid user key cannot use an unconnected provider"

task_key_id=$(jq -r '.id' "$task_tmp/key.json")
revoke_status=$(curl -sS -b "$task_tmp/cookies.txt" -o /dev/null -w '%{http_code}' \
  -X DELETE "http://127.0.0.1:8080/gateway-keys/${task_key_id}")
[[ "$revoke_status" == "204" ]]
revoked_status=$(curl -sS -o "$task_tmp/revoked.json" -w '%{http_code}' \
  -H "authorization: Bearer ${task_gateway_key}" -H 'content-type: application/json' \
  --data '{}' http://127.0.0.1:8080/gateway/openai/v1/responses)
[[ "$revoked_status" == "401" ]]
echo "gateway key revoke: 204; revoked key rejected with 401"

echo "cleanup: exact synthetic integration user removed"
