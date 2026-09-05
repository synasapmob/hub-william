-- Moves project opt-in off the disk and into the hub.
--
-- Until now each agent decided what to collect by what was written next to the
-- code: Codex read a project-local .codex/hooks.json, Claude Code read a
-- repo.name pinned in .claude/settings.json. That put the same decision in as
-- many files as there are repositories times agents, and a new machine had to
-- rediscover all of them.
--
-- The decision is the owner's, not the checkout's, so it belongs in one list
-- they can edit. Agents are configured once, globally, and report every folder
-- they run in; this list decides which of those become projects.
--
-- An empty list means every folder is collected, which is what the hub did
-- before this migration. The list only starts excluding once it has a first
-- entry, so adding one is an explicit narrowing rather than a silent one.

create table public.tracked_projects (
  owner_id uuid not null references public.profiles (id) on delete cascade,
  folder_name text not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, folder_name),
  check (char_length(folder_name) between 1 and 120)
);

alter table public.tracked_projects enable row level security;

-- Read-only from the browser like every other usage table: the list is edited
-- through provider-connections so one code path owns the writes.
revoke all on table public.tracked_projects from anon, authenticated;
grant select on table public.tracked_projects to authenticated;
grant all on table public.tracked_projects to service_role;

create policy "Approved users can read their tracked projects"
on public.tracked_projects
for select
to authenticated
using (
  owner_id = (select auth.uid())
  and exists (
    select 1
    from public.profiles as profile
    where profile.id = (select auth.uid())
      and profile.status = 'approved'
  )
);

-- Folder name rather than a path digest: this is the one project identity the
-- owner types by hand, and they know the repository as its folder. Two checkouts
-- that share a name share a list entry, which is the behaviour someone naming
-- "hub-william" expects; the rows they produce stay separate because those are
-- still keyed by the full path digest.
create or replace function public.project_is_tracked(
  p_owner_id uuid,
  p_folder_name text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required';
  end if;

  if not exists (
    select 1
    from public.tracked_projects as project
    where project.owner_id = p_owner_id
  ) then
    return true;
  end if;

  return exists (
    select 1
    from public.tracked_projects as project
    where project.owner_id = p_owner_id
      and project.folder_name = p_folder_name
  );
end;
$$;

revoke all on function public.project_is_tracked(uuid, text)
from public, anon, authenticated;
grant execute on function public.project_is_tracked(uuid, text) to service_role;

-- Claude Code's OTLP stream names no repository, so the folder has to arrive
-- from somewhere else: a lifecycle hook posts it, and this table joins that hook
-- to the usage records by session. Codex solves the same problem with
-- codex_sessions; the two stay separate because Codex additionally counts
-- prompts here and Claude Code counts them from its own telemetry.
create table public.claude_sessions (
  owner_id uuid not null references public.profiles (id) on delete cascade,
  session_id text not null,
  folder_name text not null,
  -- Kept private for support, never exposed: the browser only ever sees
  -- folder_name, so an absolute path cannot leak through the dashboard.
  cwd text not null,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (owner_id, session_id),
  check (char_length(session_id) between 1 and 200),
  check (char_length(folder_name) between 1 and 120),
  check (char_length(cwd) between 1 and 2000)
);

create index claude_sessions_owner_seen_idx
on public.claude_sessions (owner_id, last_seen_at desc);

alter table public.claude_sessions enable row level security;

revoke all on table public.claude_sessions from anon, authenticated;
grant all on table public.claude_sessions to service_role;

-- 'grok' ahead of the integration itself. The column already carries the agent,
-- and widening a check constraint later would mean a second migration whose only
-- content is a string.
alter table public.agent_projects
drop constraint agent_projects_agent_check;

alter table public.agent_projects
add constraint agent_projects_agent_check
check (agent in ('codex', 'claude_code', 'grok'));

alter table private.untracked_agent_projects
drop constraint untracked_agent_projects_agent_check;

alter table private.untracked_agent_projects
add constraint untracked_agent_projects_agent_check
check (agent in ('codex', 'claude_code', 'grok'));

-- The two claim tables exist only so a retried export cannot double count, and
-- a claim is worthless once no exporter would still retry it. They were the
-- fastest growing tables in the database — measured at roughly 3,000 rows a day
-- across two agents against 14 rows in agent_project_usage — because nothing
-- ever deleted from them.
--
-- Seven days is far past any exporter's retry window and keeps the tables at a
-- fixed size instead of a growing one.
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
end;
$$;

revoke all on function private.prune_telemetry_claims()
from public, anon, authenticated;

-- 02:30 UTC, half an hour behind provider-sync so the two never contend.
select cron.schedule(
  'telemetry-claims-prune',
  '30 2 * * *',
  $cron$select private.prune_telemetry_claims()$cron$
);
