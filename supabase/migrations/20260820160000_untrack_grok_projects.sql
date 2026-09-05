-- "Stop tracking" silently did nothing for a Grok Build project: the function
-- branched on codex and claude_code and returned false for anything else, so
-- the card stayed, its history stayed, and the folder stayed on the list.
--
-- Codex and Grok Build are the same case — both live in agent_projects, and
-- both name their folder in display_name — so they share a branch rather than
-- getting a copy each. Claude Code stays separate because its projects are
-- provider_connections, not agent_projects.

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

  if p_agent in ('codex', 'grok') then
    -- display_name is the folder, which is what the list is keyed by;
    -- project_key is a digest of the absolute path and cannot be matched.
    select project.display_name
    into v_folder_name
    from public.agent_projects as project
    where project.id = p_project_id
      and project.owner_id = p_owner_id
      and project.agent = p_agent
    for update;

    if v_folder_name is null then
      return false;
    end if;

    -- grok_runs cascades from here, so a re-run after this cannot resurrect the
    -- project through a run mapping that outlived it.
    delete from public.agent_projects
    where id = p_project_id
      and owner_id = p_owner_id
      and agent = p_agent;
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

  -- Every agent runs in the same folder, so removing it stops the others too.
  -- That is the intended reading of "stop tracking this project".
  delete from public.tracked_projects
  where owner_id = p_owner_id
    and folder_name = v_folder_name;

  return v_deleted > 0;
end;
$$;
