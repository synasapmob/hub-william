-- Gives the news feed a clock.
--
-- Hourly rather than daily, and that cadence is load-bearing rather than
-- enthusiasm: velocity is the change in an item's attention between two
-- consecutive snapshots, so the collection interval *is* the resolution of the
-- "happening now" half of the ranking. A daily job would only ever see final
-- scores and could never tell a story climbing from a story that peaked.
--
-- The secret is the one provider-sync already uses. A second shared secret
-- would be a second thing to rotate and a second way to have half the hub
-- authenticating and half of it not.

create or replace function private.run_scheduled_news_sync()
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
  where secret.name = 'news_sync_url';

  select secret.decrypted_secret into v_secret
  from vault.decrypted_secrets as secret
  where secret.name = 'provider_sync_secret';

  if v_url is null or v_secret is null then
    raise warning 'scheduled news sync is not configured; seed vault first';
    return;
  end if;

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

revoke all on function private.run_scheduled_news_sync()
  from public, anon, authenticated;

-- Summarizing is deliberately not part of collection. It costs money or quota,
-- it depends on a third party, and the feed has to keep filling while it is
-- broken. Six-hourly is enough for a page nobody reads in real time, and it
-- leaves the collector free to run every hour without paying for a model call
-- each time.
create or replace function private.run_scheduled_news_summarize()
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
  where secret.name = 'news_summarize_url';

  select secret.decrypted_secret into v_secret
  from vault.decrypted_secrets as secret
  where secret.name = 'provider_sync_secret';

  if v_url is null or v_secret is null then
    raise warning 'scheduled news summarize is not configured; seed vault first';
    return;
  end if;

  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
end;
$$;

revoke all on function private.run_scheduled_news_summarize()
  from public, anon, authenticated;

-- :05 rather than :00 so the hourly collection is not competing with every
-- other cron on the planet for the same upstream rate limits.
select cron.schedule(
  'news-sync-hourly',
  '5 * * * *',
  $cron$select private.run_scheduled_news_sync()$cron$
);

-- Half past, four hours after the daily provider sync, and offset from the
-- collector so a summarize run never starts while items are being rewritten.
select cron.schedule(
  'news-summarize-6h',
  '35 */6 * * *',
  $cron$select private.run_scheduled_news_summarize()$cron$
);
