-- Two ways the list could fail quietly, and the session tables' missing bound.

-- 1. Case. macOS and Windows filesystems are case-insensitive, so the same
-- checkout can report "Hub-William" one day and "hub-william" the next, and an
-- owner typing the name from memory has no reason to match either exactly. An
-- exact comparison turns that into silence: nothing is collected and nothing on
-- screen says why. The stored value keeps the owner's capitalisation because it
-- is what the dashboard shows; only the comparison is case-folded.
create unique index tracked_projects_owner_folder_lower_idx
on public.tracked_projects (owner_id, lower(folder_name));

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

  return exists (
    select 1
    from public.tracked_projects as project
    where project.owner_id = p_owner_id
      and lower(project.folder_name) = lower(p_folder_name)
  );
end;
$$;

-- Untracking has to fold the same way or "Stop tracking" would delete the
-- history and leave the entry that lets it come straight back.
create or replace function public.untrack_agent_project(
  p_owner_id uuid,
  p_project_id uuid,
  p_agent text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_folder_name text;
  v_deleted integer;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required';
  end if;

  if p_agent = 'codex' then
    select project.display_name
    into v_folder_name
    from public.agent_projects as project
    where project.id = p_project_id
      and project.owner_id = p_owner_id
      and project.agent = 'codex'
    for update;

    if v_folder_name is null then
      return false;
    end if;

    delete from public.agent_projects
    where id = p_project_id
      and owner_id = p_owner_id
      and agent = 'codex';
  elsif p_agent = 'claude_code' then
    select connection.external_account_id
    into v_folder_name
    from public.provider_connections as connection
    where connection.id = p_project_id
      and connection.owner_id = p_owner_id
      and connection.provider = 'anthropic'
      and connection.connection_method = 'collector'
      and connection.metadata ->> 'product' = 'claude_code'
    for update;

    if v_folder_name is null then
      return false;
    end if;

    delete from public.provider_connections
    where id = p_project_id
      and owner_id = p_owner_id
      and provider = 'anthropic'
      and connection_method = 'collector';
  else
    return false;
  end if;

  get diagnostics v_deleted = row_count;

  delete from public.tracked_projects
  where owner_id = p_owner_id
    and lower(folder_name) = lower(v_folder_name);

  return v_deleted > 0;
end;
$$;

-- 2. Session mappings had no bound. One row per CLI session, kept forever, for
-- a lookup that only matters while that session is still exporting. The claim
-- tables were given a prune in the same migration that created this problem;
-- these were missed.
--
-- Thirty days rather than the claims' seven: a mapping is what attributes usage
-- to a project, so an export arriving late must still find it.
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

  delete from public.claude_sessions
  where last_seen_at < now() - interval '30 days';

  delete from public.codex_sessions
  where last_seen_at < now() - interval '30 days';
end;
$$;
