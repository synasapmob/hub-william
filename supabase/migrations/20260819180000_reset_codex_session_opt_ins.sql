-- Before Codex telemetry became project opt-in, a user-level hook could map
-- every local repo into codex_sessions. Those private mappings must not remain
-- an authorization shortcut after the new project-local gate ships. Usage
-- aggregates and project history remain intact; an opted-in project's next
-- SessionStart or UserPromptSubmit recreates only its session mapping.

delete from public.codex_sessions;
