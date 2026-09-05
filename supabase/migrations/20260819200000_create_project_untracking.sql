-- Removing a telemetry project from the dashboard must outlive the current
-- row. Otherwise the next exporter retry recreates it immediately. The
-- tombstone stores only the same opaque project identity already used for
-- attribution and can be cleared only by an explicit future opt-in flow.

create table private.untracked_agent_projects (
  owner_id uuid not null references public.profiles (id) on delete cascade,
  agent text not null check (agent in ('codex', 'claude_code')),
  project_key text not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, agent, project_key)
);

revoke all on table private.untracked_agent_projects from public, anon, authenticated;
grant all on table private.untracked_agent_projects to service_role;

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
  v_project_key text;
  v_deleted integer;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required';
  end if;

  if p_agent = 'codex' then
    select project.project_key
    into v_project_key
    from public.agent_projects as project
    where project.id = p_project_id
      and project.owner_id = p_owner_id
      and project.agent = 'codex'
    for update;

    if v_project_key is null then
      return false;
    end if;

    insert into private.untracked_agent_projects (owner_id, agent, project_key)
    values (p_owner_id, 'codex', v_project_key)
    on conflict do nothing;

    delete from public.agent_projects
    where id = p_project_id
      and owner_id = p_owner_id
      and agent = 'codex';
  elsif p_agent = 'claude_code' then
    select connection.external_account_id
    into v_project_key
    from public.provider_connections as connection
    where connection.id = p_project_id
      and connection.owner_id = p_owner_id
      and connection.provider = 'anthropic'
      and connection.connection_method = 'collector'
      and connection.metadata ->> 'product' = 'claude_code'
    for update;

    if v_project_key is null then
      return false;
    end if;

    insert into private.untracked_agent_projects (owner_id, agent, project_key)
    values (p_owner_id, 'claude_code', v_project_key)
    on conflict do nothing;

    delete from public.provider_connections
    where id = p_project_id
      and owner_id = p_owner_id
      and provider = 'anthropic'
      and connection_method = 'collector';
  else
    return false;
  end if;

  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

revoke all on function public.untrack_agent_project(uuid, uuid, text)
from public, anon, authenticated;
grant execute on function public.untrack_agent_project(uuid, uuid, text)
to service_role;

create or replace function public.agent_project_is_untracked(
  p_owner_id uuid,
  p_agent text,
  p_project_key text
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
    from private.untracked_agent_projects as project
    where project.owner_id = p_owner_id
      and project.agent = p_agent
      and project.project_key = p_project_key
  );
end;
$$;

revoke all on function public.agent_project_is_untracked(uuid, text, text)
from public, anon, authenticated;
grant execute on function public.agent_project_is_untracked(uuid, text, text)
to service_role;

comment on function public.untrack_agent_project(uuid, uuid, text) is
  'Deletes one owned project and tombstones its telemetry identity so exporters cannot recreate it.';
