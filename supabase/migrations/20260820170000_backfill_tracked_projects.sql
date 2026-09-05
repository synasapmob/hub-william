-- Carries every folder that already has history onto the tracked list.
--
-- 20260820120000 made an empty list collect nothing, which is the right default
-- for a list that exists to be an opt-in. What it did not do is carry the
-- existing projects across, so every repository that had been collecting for
-- weeks went silent the moment it ran — with a card still on the dashboard
-- showing the history it had already gathered, and nothing on screen to say the
-- numbers had stopped moving. An owner who had never opened Tracked projects
-- had opted into nothing, so nothing is what they got.
--
-- Naming a folder is the clearest statement of intent an owner can make, and
-- having run an agent in it for weeks is the next clearest. This treats the
-- second as standing for the first, once.
--
-- The list is agent-agnostic — project_is_tracked takes only a folder name — so
-- one row here re-enables Codex, Claude Code and Grok Build together in that
-- folder. Both sources are read because the two model a project differently:
-- Codex and Grok Build keep rows in agent_projects, while Claude Code's
-- projects are collector connections.

insert into public.tracked_projects (owner_id, folder_name)
select distinct on (owner_id, lower(folder_name)) owner_id, folder_name
from (
  select project.owner_id, project.display_name as folder_name
  from public.agent_projects as project

  union all

  select connection.owner_id, connection.external_account_id as folder_name
  from public.provider_connections as connection
  where connection.connection_method = 'collector'
    and connection.external_account_id is not null
) as existing
-- The sentinel a Claude Code session gets when it reports no repository at all.
-- It names no folder, so it cannot be one an owner meant to track.
where folder_name <> '__unlabelled__'
  and char_length(folder_name) between 1 and 120
-- DISTINCT ON above settles collisions inside this statement; this settles them
-- against rows the owner had already added by hand, and makes the migration
-- safe to run twice.
on conflict do nothing;
