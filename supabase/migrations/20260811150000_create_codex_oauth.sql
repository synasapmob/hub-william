-- Codex (ChatGPT subscription) connections authenticated with the device-code
-- flow and polled server-side. Replaces the local-connector design: no CLI, no
-- pairing token, no connector credential. Provider OAuth tokens live in
-- private.provider_credentials like every other OAuth provider.

-- Codex reports a single account-wide token total per day rather than an
-- input/output split, so daily buckets need a total-only column.
alter table public.usage_buckets
add column if not exists total_tokens bigint
  check (total_tokens is null or total_tokens >= 0);

-- Lifetime/streak counters from GET /backend-api/wham/profiles/me. These are an
-- alternative view of activity, never additive with usage_buckets.
create table public.provider_usage_summaries (
  connection_id uuid primary key references public.provider_connections (id) on delete cascade,
  lifetime_tokens bigint check (lifetime_tokens is null or lifetime_tokens >= 0),
  peak_daily_tokens bigint check (peak_daily_tokens is null or peak_daily_tokens >= 0),
  longest_running_turn_seconds bigint check (
    longest_running_turn_seconds is null or longest_running_turn_seconds >= 0
  ),
  current_streak_days integer check (
    current_streak_days is null or current_streak_days >= 0
  ),
  longest_streak_days integer check (
    longest_streak_days is null or longest_streak_days >= 0
  ),
  observed_at timestamptz not null
);

-- Rate-limit reset credits from GET /backend-api/wham/rate-limit-reset-credits.
-- available_count over total_earned_count is the "2 of 3" the dashboard shows.
create table public.provider_reset_credits (
  connection_id uuid primary key references public.provider_connections (id) on delete cascade,
  available_count integer not null default 0 check (available_count >= 0),
  total_earned_count integer not null default 0 check (total_earned_count >= 0),
  credits jsonb not null default '[]'::jsonb,
  observed_at timestamptz not null
);

-- A device authorization in flight. Holds no token: the user_code is only
-- meaningful together with OpenAI's own approval, and it expires in ~15 min.
create table private.provider_device_auth_sessions (
  connection_id uuid primary key references public.provider_connections (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  device_auth_id text not null,
  user_code text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index provider_device_auth_sessions_expiry_idx
on private.provider_device_auth_sessions (expires_at)
where consumed_at is null;

alter table public.provider_usage_summaries enable row level security;
alter table public.provider_reset_credits enable row level security;
alter table private.provider_device_auth_sessions enable row level security;

revoke all on table public.provider_usage_summaries from anon, authenticated;
revoke all on table public.provider_reset_credits from anon, authenticated;
grant select on table public.provider_usage_summaries to authenticated;
grant select on table public.provider_reset_credits to authenticated;
grant all on table public.provider_usage_summaries to service_role;
grant all on table public.provider_reset_credits to service_role;

create policy "Approved users can read their provider usage summaries"
on public.provider_usage_summaries
for select
to authenticated
using (
  exists (
    select 1
    from public.provider_connections as connection
    where connection.id = provider_usage_summaries.connection_id
      and connection.owner_id = (select auth.uid())
  )
  and (select public.is_approved_user())
);

create policy "Approved users can read their provider reset credits"
on public.provider_reset_credits
for select
to authenticated
using (
  exists (
    select 1
    from public.provider_connections as connection
    where connection.id = provider_reset_credits.connection_id
      and connection.owner_id = (select auth.uid())
  )
  and (select public.is_approved_user())
);

-- Creates the placeholder connection and records the device authorization that
-- the browser will poll. Expired, unconsumed attempts are reaped first so a
-- user who abandons the dialog does not accumulate 'verifying' rows.
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
    and connection.status = 'verifying'
    and session.consumed_at is null
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

create or replace function public.read_codex_device_auth(
  p_connection_id uuid,
  p_owner_id uuid
)
returns table (
  device_auth_id text,
  user_code text,
  expires_at timestamptz,
  consumed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required';
  end if;

  return query
  select
    session.device_auth_id,
    session.user_code,
    session.expires_at,
    session.consumed_at
  from private.provider_device_auth_sessions as session
  where session.connection_id = p_connection_id
    and session.owner_id = p_owner_id;
end;
$$;

-- Marks the attempt consumed. Returns false when it was already consumed, so a
-- double-poll cannot exchange the same authorization twice.
create or replace function public.consume_codex_device_auth(
  p_connection_id uuid,
  p_owner_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated uuid;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required';
  end if;

  update private.provider_device_auth_sessions
  set consumed_at = now()
  where connection_id = p_connection_id
    and owner_id = p_owner_id
    and consumed_at is null
    and expires_at > now()
  returning connection_id into v_updated;

  return v_updated is not null;
end;
$$;

revoke all on function public.create_codex_device_auth(uuid, text, text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.read_codex_device_auth(uuid, uuid) from public, anon, authenticated;
revoke all on function public.consume_codex_device_auth(uuid, uuid) from public, anon, authenticated;

grant execute on function public.create_codex_device_auth(uuid, text, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.read_codex_device_auth(uuid, uuid) to service_role;
grant execute on function public.consume_codex_device_auth(uuid, uuid) to service_role;

comment on table public.provider_usage_summaries is
  'Account-level lifetime counters. Never added to usage_buckets; they are an alternative view.';
comment on table public.provider_reset_credits is
  'Codex rate-limit reset credits. available_count over total_earned_count renders as "2 of 3".';
comment on table private.provider_device_auth_sessions is
  'In-flight OAuth device authorizations. Holds no access or refresh token.';
