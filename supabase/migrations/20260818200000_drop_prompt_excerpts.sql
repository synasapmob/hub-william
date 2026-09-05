-- Prompt text stops being stored, and what was already stored is dropped.
--
-- The 500-character cap and the opt-in flag made the excerpt look like a
-- bounded, deliberate sample. It never was: a prompt is whatever was typed or
-- pasted at a terminal, so one paste of an API key, a token or a password lands
-- in this column and then stays — in the table, in every backup taken since,
-- and in any dump. Hiding the column behind a role would leave all of that
-- intact and only remove the way it was noticed, so the column goes instead of
-- its readers.
--
-- Everything that is a fact *about* a prompt rather than its content stays:
-- when it ran, how long it was, which slash command started it, and which model
-- spent the most tokens on it. Every count the dashboard draws is built from
-- those, so none of them change.

alter table public.prompt_events drop column excerpt;

comment on table public.prompt_events is
  'One row per Claude Code user prompt. Metadata only — prompt text is never stored, so a secret pasted at the CLI cannot land here.';

-- Dropped rather than replaced: the parameter list changes, so leaving the old
-- signature in place would keep an overload that still accepts prompt text and
-- writes it to a column that no longer exists.
drop function if exists public.record_claude_prompt(uuid, text, text, timestamptz, text, integer, text, text);

create or replace function public.record_claude_prompt(
  p_connection_id uuid,
  p_prompt_id text,
  p_session_id text,
  p_occurred_at timestamptz,
  p_prompt_length integer,
  p_command_name text,
  p_command_source text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required';
  end if;

  insert into public.prompt_events as event (
    connection_id,
    prompt_id,
    session_id,
    occurred_at,
    prompt_length,
    command_name,
    command_source
  )
  values (
    p_connection_id,
    p_prompt_id,
    p_session_id,
    p_occurred_at,
    coalesce(p_prompt_length, 0),
    p_command_name,
    p_command_source
  )
  on conflict (connection_id, prompt_id)
  do update set
    session_id = coalesce(excluded.session_id, event.session_id),
    occurred_at = least(event.occurred_at, excluded.occurred_at),
    prompt_length = greatest(event.prompt_length, excluded.prompt_length),
    command_name = coalesce(excluded.command_name, event.command_name),
    command_source = coalesce(excluded.command_source, event.command_source),
    observed_at = now();
end;
$$;

revoke all on function public.record_claude_prompt(uuid, text, text, timestamptz, integer, text, text) from public, anon, authenticated;
grant execute on function public.record_claude_prompt(uuid, text, text, timestamptz, integer, text, text) to service_role;
