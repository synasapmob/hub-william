-- Codex account authorization and Codex project activity are different facts:
-- OAuth connections describe the real ChatGPT accounts that provide quota,
-- while these rows describe where the local agent spent that quota. Keeping
-- project activity outside provider_connections prevents a repository from
-- masquerading as another connected account.

create table public.agent_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  agent text not null check (agent in ('codex', 'claude_code')),
  project_key text not null,
  display_name text not null,
  last_active_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(project_key) between 1 and 500),
  check (char_length(display_name) between 1 and 120),
  unique (owner_id, agent, project_key)
);

create index agent_projects_owner_active_idx
on public.agent_projects (owner_id, last_active_at desc);

-- The hook is the stable bridge between a local cwd and Codex's OTel
-- conversation.id. A SessionStart or UserPromptSubmit can arrive before or
-- after the telemetry batch, so both sides upsert independently and are joined
-- by session_id when usage is recorded.
create table public.codex_sessions (
  owner_id uuid not null references public.profiles (id) on delete cascade,
  session_id text not null,
  project_id uuid not null references public.agent_projects (id) on delete cascade,
  cwd text not null,
  model text,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  prompt_count bigint not null default 0 check (prompt_count >= 0),
  primary key (owner_id, session_id),
  check (char_length(session_id) between 1 and 200),
  check (char_length(cwd) between 1 and 2000)
);

create index codex_sessions_project_seen_idx
on public.codex_sessions (project_id, last_seen_at desc);

create table public.agent_project_usage (
  project_id uuid not null references public.agent_projects (id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  model text not null,
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cached_input_tokens bigint not null default 0 check (cached_input_tokens >= 0),
  reasoning_tokens bigint not null default 0 check (reasoning_tokens >= 0),
  request_count bigint not null default 0 check (request_count >= 0),
  prompt_count bigint not null default 0 check (prompt_count >= 0),
  observed_at timestamptz not null default now(),
  primary key (project_id, period_start, model),
  check (period_end > period_start)
);

create index agent_project_usage_project_period_idx
on public.agent_project_usage (project_id, period_start desc);

-- OTLP retries are routine. A completed response is claimed before its token
-- delta is added, so accepting the same export twice cannot inflate usage.
create table public.codex_usage_claims (
  owner_id uuid not null references public.profiles (id) on delete cascade,
  event_key text not null,
  observed_at timestamptz not null default now(),
  primary key (owner_id, event_key),
  check (char_length(event_key) between 1 and 500)
);

create index codex_usage_claims_observed_idx
on public.codex_usage_claims (observed_at);

alter table public.agent_projects enable row level security;
alter table public.codex_sessions enable row level security;
alter table public.agent_project_usage enable row level security;
alter table public.codex_usage_claims enable row level security;

revoke all on table public.agent_projects from anon, authenticated;
revoke all on table public.codex_sessions from anon, authenticated;
revoke all on table public.agent_project_usage from anon, authenticated;
revoke all on table public.codex_usage_claims from anon, authenticated;

grant select on table public.agent_projects to authenticated;
grant select on table public.agent_project_usage to authenticated;
grant all on table public.agent_projects to service_role;
grant all on table public.codex_sessions to service_role;
grant all on table public.agent_project_usage to service_role;
grant all on table public.codex_usage_claims to service_role;

create policy "Approved users can read their agent projects"
on public.agent_projects
for select
to authenticated
using (
  owner_id = (select auth.uid())
  and (select public.is_approved_user())
);

create policy "Approved users can read their project usage"
on public.agent_project_usage
for select
to authenticated
using (
  exists (
    select 1
    from public.agent_projects as project
    where project.id = agent_project_usage.project_id
      and project.owner_id = (select auth.uid())
  )
  and (select public.is_approved_user())
);

-- Session hooks send a cwd that may contain a username or an internal path.
-- It is needed only for attribution and is deliberately not readable by the
-- browser role. The UI receives the bounded display_name from agent_projects.

create or replace function public.record_codex_session(
  p_owner_id uuid,
  p_session_id text,
  p_project_key text,
  p_display_name text,
  p_cwd text,
  p_model text,
  p_prompt_key text,
  p_prompt_delta bigint,
  p_observed_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_id uuid;
  v_prompt_delta bigint := 0;
  v_claimed integer;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required';
  end if;

  if p_prompt_delta < 0 then
    raise exception 'prompt delta must not be negative';
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
    'codex',
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

  if p_prompt_delta > 0 and nullif(p_prompt_key, '') is not null then
    insert into public.codex_usage_claims (owner_id, event_key)
    values (p_owner_id, left('prompt:' || p_session_id || ':' || p_prompt_key, 500))
    on conflict do nothing;

    get diagnostics v_claimed = row_count;

    if v_claimed > 0 then
      v_prompt_delta := p_prompt_delta;
    end if;
  end if;

  insert into public.codex_sessions as session (
    owner_id,
    session_id,
    project_id,
    cwd,
    model,
    started_at,
    last_seen_at,
    prompt_count
  )
  values (
    p_owner_id,
    left(p_session_id, 200),
    v_project_id,
    left(p_cwd, 2000),
    nullif(left(p_model, 200), ''),
    p_observed_at,
    p_observed_at,
    v_prompt_delta
  )
  on conflict (owner_id, session_id)
  do update set
    project_id = excluded.project_id,
    cwd = excluded.cwd,
    model = coalesce(excluded.model, session.model),
    last_seen_at = greatest(session.last_seen_at, excluded.last_seen_at),
    prompt_count = session.prompt_count + excluded.prompt_count;

  if v_prompt_delta > 0 then
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
      date_trunc('hour', p_observed_at),
      date_trunc('hour', p_observed_at) + interval '1 hour',
      left(coalesce(nullif(p_model, ''), 'unknown'), 200),
      0,
      0,
      0,
      0,
      0,
      v_prompt_delta
    )
    on conflict (project_id, period_start, model)
    do update set
      prompt_count = usage.prompt_count + excluded.prompt_count,
      observed_at = now();
  end if;

  return v_project_id;
end;
$$;

-- One transaction claims and aggregates a response.completed event. Unknown
-- sessions are ignored rather than assigned to a fake project; a later hook
-- event will make future usage attributable without inventing history.
create or replace function public.record_codex_project_usage(
  p_owner_id uuid,
  p_session_id text,
  p_event_key text,
  p_period_start timestamptz,
  p_model text,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cached_input_tokens bigint,
  p_reasoning_tokens bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_id uuid;
  v_claimed integer;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required';
  end if;

  select session.project_id into v_project_id
  from public.codex_sessions as session
  where session.owner_id = p_owner_id
    and session.session_id = p_session_id;

  if v_project_id is null then
    return false;
  end if;

  insert into public.codex_usage_claims (owner_id, event_key)
  values (p_owner_id, left(p_event_key, 500))
  on conflict do nothing;

  get diagnostics v_claimed = row_count;

  if v_claimed = 0 then
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
    1,
    0
  )
  on conflict (project_id, period_start, model)
  do update set
    input_tokens = usage.input_tokens + excluded.input_tokens,
    output_tokens = usage.output_tokens + excluded.output_tokens,
    cached_input_tokens = usage.cached_input_tokens + excluded.cached_input_tokens,
    reasoning_tokens = usage.reasoning_tokens + excluded.reasoning_tokens,
    request_count = usage.request_count + 1,
    observed_at = now();

  update public.agent_projects
  set last_active_at = greatest(last_active_at, p_period_start),
      updated_at = now()
  where id = v_project_id;

  update public.codex_sessions
  set last_seen_at = greatest(last_seen_at, p_period_start),
      model = coalesce(nullif(p_model, ''), model)
  where owner_id = p_owner_id
    and session_id = p_session_id;

  return true;
end;
$$;

revoke all on function public.record_codex_session(uuid, text, text, text, text, text, text, bigint, timestamptz) from public, anon, authenticated;
revoke all on function public.record_codex_project_usage(uuid, text, text, timestamptz, text, bigint, bigint, bigint, bigint) from public, anon, authenticated;
grant execute on function public.record_codex_session(uuid, text, text, text, text, text, text, bigint, timestamptz) to service_role;
grant execute on function public.record_codex_project_usage(uuid, text, text, timestamptz, text, bigint, bigint, bigint, bigint) to service_role;
