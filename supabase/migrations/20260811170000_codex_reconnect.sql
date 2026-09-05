-- Recovery path for Codex connections.
--
-- The initial device-auth flow could strand a connection: once a session was
-- consumed it could never be re-opened, so any failure between consumption and
-- the first successful sync left a row that showed "Synced never" with no way
-- back except deleting it. This adds a restart that reuses the existing
-- connection, so reconnecting keeps the account's history instead of
-- discarding it.

create or replace function public.restart_codex_device_auth(
  p_connection_id uuid,
  p_owner_id uuid,
  p_device_auth_id text,
  p_user_code text,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owned uuid;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required';
  end if;

  if p_expires_at <= now() or p_expires_at > now() + interval '30 minutes' then
    raise exception 'invalid device authorization expiry';
  end if;

  -- Ownership and product are enforced here so the caller cannot restart an
  -- authorization against somebody else's connection.
  select connection.id
  into v_owned
  from public.provider_connections as connection
  where connection.id = p_connection_id
    and connection.owner_id = p_owner_id
    and connection.metadata ->> 'product' = 'codex'
  for update;

  if v_owned is null then
    return false;
  end if;

  insert into private.provider_device_auth_sessions (
    connection_id,
    owner_id,
    device_auth_id,
    user_code,
    expires_at,
    consumed_at
  )
  values (
    p_connection_id,
    p_owner_id,
    p_device_auth_id,
    p_user_code,
    p_expires_at,
    null
  )
  on conflict (connection_id) do update
  set device_auth_id = excluded.device_auth_id,
      user_code = excluded.user_code,
      expires_at = excluded.expires_at,
      consumed_at = null,
      created_at = now();

  update public.provider_connections
  set status = 'verifying',
      last_error = null
  where id = p_connection_id;

  return true;
end;
$$;

revoke all on function public.restart_codex_device_auth(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.restart_codex_device_auth(uuid, uuid, text, text, timestamptz) to service_role;

-- The original reaper only removed sessions that were never consumed, so a
-- consumed-but-failed attempt left an orphan 'verifying' connection forever.
-- Scope the sweep to the caller's own abandoned attempts.
create or replace function public.create_codex_device_auth(
  p_owner_id uuid,
  p_display_name text,
  p_device_auth_id text,
  p_user_code text,
  p_expires_at timestamptz,
  p_history_starts_at timestamptz
)
returns table (connection_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection_id uuid;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required';
  end if;

  if p_expires_at <= now() or p_expires_at > now() + interval '30 minutes' then
    raise exception 'invalid device authorization expiry';
  end if;

  delete from public.provider_connections as connection
  using private.provider_device_auth_sessions as session
  where connection.id = session.connection_id
    and connection.owner_id = p_owner_id
    and connection.status = 'verifying'
    and connection.last_synced_at is null
    and session.expires_at <= now();

  insert into public.provider_connections (
    owner_id,
    provider,
    connection_method,
    status,
    display_name,
    workspace_name,
    history_starts_at,
    capabilities,
    metadata
  )
  values (
    p_owner_id,
    'openai',
    'oauth',
    'verifying',
    p_display_name,
    p_display_name,
    p_history_starts_at,
    '{"usage":true,"cost":false,"limits":true,"resets":true,"modelBreakdown":false,"tokenBreakdown":false}'::jsonb,
    '{"product":"codex","transport":"device_code"}'::jsonb
  )
  returning id into v_connection_id;

  insert into private.provider_device_auth_sessions (
    connection_id,
    owner_id,
    device_auth_id,
    user_code,
    expires_at
  )
  values (
    v_connection_id,
    p_owner_id,
    p_device_auth_id,
    p_user_code,
    p_expires_at
  );

  return query select v_connection_id;
end;
$$;

comment on function public.restart_codex_device_auth(uuid, uuid, text, text, timestamptz) is
  'Re-opens device authorization for an existing Codex connection so a stranded or expired sign-in can be recovered without losing history.';
