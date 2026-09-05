-- Grok Build reports usage by pushing OpenTelemetry, the way Claude Code does,
-- but one difference decides this whole schema: its usage records carry no
-- session id. grok_code.api_request carries the model and the token counts and
-- nothing that says which session, prompt, or folder produced them. session.id
-- is present only on grok_code.session_start and grok_code.model_switched, and
-- setting OTEL_METRICS_INCLUDE_SESSION_ID does not add it.
--
-- So the correlation is carried outside the payload. The exporter is pointed at
-- a per-launch URL — .../grok-otel/r/<run id>/v1/logs — and a lifecycle hook
-- reports that same run id together with the folder the session is running in.
-- grok_runs is that join, and it is the only reason a Grok token can be
-- attributed to a repository at all. A batch whose run was never announced is
-- dropped rather than parked: the hook fires again on the next prompt, so a run
-- repairs itself within one turn.
--
-- Projects live in agent_projects alongside Codex's rather than in
-- provider_connections. There is no Grok account to connect and no quota
-- endpoint to poll, so there is no connection to model — only the places where
-- a local agent spent tokens.

create table public.grok_runs (
  owner_id uuid not null references public.profiles (id) on delete cascade,
  run_id text not null,
  project_id uuid not null references public.agent_projects (id) on delete cascade,
  session_id text not null,
  -- Kept private for support and deliberately not readable by the browser role:
  -- an absolute path names the machine's owner. The UI receives the bounded
  -- display_name from agent_projects instead.
  cwd text not null,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (owner_id, run_id),
  check (char_length(run_id) between 1 and 200),
  check (char_length(session_id) between 1 and 200),
  check (char_length(cwd) between 1 and 2000)
);

create index grok_runs_project_seen_idx
on public.grok_runs (project_id, last_seen_at desc);

-- OTLP exporters retry any batch they do not see acknowledged, so redelivery is
-- routine. Grok Build assigns no request id, so a record is claimed by its own
-- nanosecond clock — the only value on an api_request that is both stable
-- across a redelivery and unique between two genuine requests.
create table public.grok_usage_claims (
  owner_id uuid not null references public.profiles (id) on delete cascade,
  event_key text not null,
  observed_at timestamptz not null default now(),
  primary key (owner_id, event_key),
  check (char_length(event_key) between 1 and 500)
);

create index grok_usage_claims_observed_idx
on public.grok_usage_claims (observed_at);

alter table public.grok_runs enable row level security;
alter table public.grok_usage_claims enable row level security;

revoke all on table public.grok_runs from anon, authenticated;
revoke all on table public.grok_usage_claims from anon, authenticated;

grant all on table public.grok_runs to service_role;
grant all on table public.grok_usage_claims to service_role;

-- Announces a run and the project it belongs to. Called from the lifecycle
-- hook, which is the only source that knows both the run id and the folder.
create or replace function public.record_grok_run(
  p_owner_id uuid,
  p_run_id text,
  p_session_id text,
  p_project_key text,
  p_display_name text,
  p_cwd text,
  p_observed_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_id uuid;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required';
  end if;

  insert into public.agent_projects as project (
    owner_id,
    agent,
    project_key,
    display_name,
    last_active_at
  )
  values (
    p_owner_id,
    'grok',
    left(p_project_key, 500),
    left(p_display_name, 120),
    p_observed_at
  )
  on conflict (owner_id, agent, project_key)
  do update set
    display_name = excluded.display_name,
    last_active_at = greatest(project.last_active_at, excluded.last_active_at),
    updated_at = now()
  returning id into v_project_id;

  insert into public.grok_runs as run (
    owner_id,
    run_id,
    project_id,
    session_id,
    cwd,
    started_at,
    last_seen_at
  )
  values (
    p_owner_id,
    left(p_run_id, 200),
    v_project_id,
    left(p_session_id, 200),
    left(p_cwd, 2000),
    p_observed_at,
    p_observed_at
  )
  on conflict (owner_id, run_id)
  do update set
    project_id = excluded.project_id,
    session_id = excluded.session_id,
    cwd = excluded.cwd,
    last_seen_at = greatest(run.last_seen_at, excluded.last_seen_at);

  return v_project_id;
end;
$$;

-- Adds one already-aggregated hour of a run's usage to its project. The caller
-- claims each event before aggregating, so this only ever adds work that has
-- not been counted before.
--
-- A run the hook never announced returns false rather than inventing a project,
-- which is what keeps an untracked folder from appearing by way of telemetry.
create or replace function public.record_grok_project_usage(
  p_owner_id uuid,
  p_run_id text,
  p_period_start timestamptz,
  p_model text,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cached_input_tokens bigint,
  p_reasoning_tokens bigint,
  p_request_count bigint,
  p_prompt_count bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_id uuid;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required';
  end if;

  select run.project_id into v_project_id
  from public.grok_runs as run
  where run.owner_id = p_owner_id
    and run.run_id = p_run_id;

  if v_project_id is null then
    return false;
  end if;

  insert into public.agent_project_usage as usage (
    project_id,
    period_start,
    period_end,
    model,
    input_tokens,
    output_tokens,
    cached_input_tokens,
    reasoning_tokens,
    request_count,
    prompt_count
  )
  values (
    v_project_id,
    p_period_start,
    p_period_start + interval '1 hour',
    left(coalesce(nullif(p_model, ''), 'unknown'), 200),
    greatest(p_input_tokens, 0),
    greatest(p_output_tokens, 0),
    greatest(p_cached_input_tokens, 0),
    greatest(p_reasoning_tokens, 0),
    greatest(p_request_count, 0),
    greatest(p_prompt_count, 0)
  )
  on conflict (project_id, period_start, model)
  do update set
    input_tokens = usage.input_tokens + excluded.input_tokens,
    output_tokens = usage.output_tokens + excluded.output_tokens,
    cached_input_tokens = usage.cached_input_tokens + excluded.cached_input_tokens,
    reasoning_tokens = usage.reasoning_tokens + excluded.reasoning_tokens,
    request_count = usage.request_count + excluded.request_count,
    prompt_count = usage.prompt_count + excluded.prompt_count,
    observed_at = now();

  update public.agent_projects
  set last_active_at = greatest(last_active_at, p_period_start),
      updated_at = now()
  where id = v_project_id;

  update public.grok_runs
  set last_seen_at = greatest(last_seen_at, p_period_start)
  where owner_id = p_owner_id
    and run_id = p_run_id;

  return true;
end;
$$;

revoke all on function public.record_grok_run(uuid, text, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.record_grok_project_usage(uuid, text, timestamptz, text, bigint, bigint, bigint, bigint, bigint, bigint) from public, anon, authenticated;

grant execute on function public.record_grok_run(uuid, text, text, text, text, text, timestamptz) to service_role;
grant execute on function public.record_grok_project_usage(uuid, text, timestamptz, text, bigint, bigint, bigint, bigint, bigint, bigint) to service_role;

-- The claim tables are pruned together; a third agent adds a third table rather
-- than a second schedule.
create or replace function private.prune_telemetry_claims()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.claude_request_ids
  where observed_at < now() - interval '7 days';

  delete from public.codex_usage_claims
  where observed_at < now() - interval '7 days';

  delete from public.grok_usage_claims
  where observed_at < now() - interval '7 days';
end;
$$;

revoke all on function private.prune_telemetry_claims()
from public, anon, authenticated;

comment on table public.grok_runs is
  'Joins a Grok Build launch to the folder it ran in. Grok telemetry carries no session id, so this mapping is the only route from a token to a project.';
