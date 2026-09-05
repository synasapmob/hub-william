-- Gives provider-sync a clock.
--
-- The machinery for noticing a broken connection already existed: a failed sync
-- writes 'needs_attention' with the reason, and provider-sync reads that status
-- back so a recovered account heals itself. What was missing is anything that
-- runs it. Nothing was scheduled, so the only trigger was somebody pressing
-- "Retry sync", and a Codex account whose OAuth session OpenAI had ended sat
-- dead for days before announcing itself mid-turn in the CLI.
--
-- The daily call is also what keeps a live connection live: the sync path
-- refreshes on 401, so a token repudiated upstream is renewed here rather than
-- on the owner's next turn.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The URL and the shared secret are per-project runtime values rather than
-- schema, so they come from Vault and are seeded out of band. Committing either
-- would put a credential in git and pin every environment to one project ref.
create or replace function private.run_scheduled_provider_sync()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select secret.decrypted_secret into v_url
  from vault.decrypted_secrets as secret
  where secret.name = 'provider_sync_url';

  select secret.decrypted_secret into v_secret
  from vault.decrypted_secrets as secret
  where secret.name = 'provider_sync_secret';

  -- A project that has not been seeded stays quiet rather than posting an
  -- unauthenticated request the function would answer 401 to, every day.
  if v_url is null or v_secret is null then
    raise warning 'scheduled provider sync is not configured; seed vault first';
    return;
  end if;

  -- Fire and forget: pg_net queues the request and the response lands in
  -- net._http_response. The sync writes its own outcome to provider_sync_runs,
  -- which is the record worth reading anyway.
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function private.run_scheduled_provider_sync()
  from public, anon, authenticated;

-- 02:00 UTC is 09:00 for the owner, so a session that died overnight is already
-- flagged on the dashboard before the first turn of the day is typed.
select cron.schedule(
  'provider-sync-daily',
  '0 2 * * *',
  $cron$select private.run_scheduled_provider_sync()$cron$
);
