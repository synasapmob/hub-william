-- Makes the tracked list an opt-in rather than a narrowing.
--
-- It shipped as "empty collects everything", chosen so the migration that
-- introduced it changed no behaviour on the day it ran. That preserved the old
-- default at the cost of the reason the list exists: the hub kept filling with
-- every repository an agent was ever opened in, which is what the list was
-- added to stop.
--
-- An empty list now collects nothing. A folder is recorded because the owner
-- named it, and for no other reason. The cost is that an empty list is silent
-- rather than permissive, so the dashboard has to say so plainly.
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
      and project.folder_name = p_folder_name
  );
end;
$$;
