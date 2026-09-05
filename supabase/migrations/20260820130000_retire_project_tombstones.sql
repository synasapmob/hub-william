-- Leaves the tracked list as the only thing that decides what is collected.
--
-- Untracking predates the list. When every folder was collected by default,
-- removing a project needed a tombstone, or the next export recreated the row
-- it had just deleted. The tombstone was permanent by design and keyed by a
-- path digest no interface can show.
--
-- Under an opt-in list that guard is not merely redundant, it is a trap: the
-- tombstone is consulted before the list, so a project removed with "Stop
-- tracking" could be added back to Tracked projects and stay silently dead,
-- with nothing on screen to explain why. Adding a folder is the clearest
-- statement of intent the owner can make and nothing older should outrank it.
--
-- Untracking now removes the folder from the list instead. The list stops the
-- recreation the tombstone used to stop, and the same click still deletes the
-- history.

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
    -- display_name is the folder, which is what the list is keyed by;
    -- project_key is a digest of the absolute path and cannot be matched.
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

  -- Both agents run in the same folder, so removing it stops the other one too.
  -- That is the intended reading of "stop tracking this project".
  delete from public.tracked_projects
  where owner_id = p_owner_id
    and folder_name = v_folder_name;

  return v_deleted > 0;
end;
$$;

-- Nothing reads these any more, and a stale row would keep meaning something to
-- a reader of the schema. The table stays for one release so a rollback has
-- somewhere to land.
delete from private.untracked_agent_projects;
