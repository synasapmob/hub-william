-- Two sources that were verified by hand and still do not work in production.
--
-- Both were confirmed against the live table: every run since the feed went up
-- recorded an error for these two and stored no rows at all.

-- The Verge's path segments were transposed. /tech/rss/index.xml is a 404;
-- /rss/tech/index.xml is the feed. The connector now points at the latter, so
-- this only clears the error the old URL left behind.
update public.news_sources
set last_error = null,
    updated_at = now()
where id = 'verge-tech';

-- Reddit answers 200 to a laptop and 403 to Supabase's edge, whatever
-- User-Agent it sends: the block is on the datacenter range, not the client.
-- Nothing in the connector can get around that, so the source is switched off
-- rather than left to fail hourly and sit red on the source-health panel.
--
-- The row stays so the history and the reason stay with it. Re-enabling it is
-- one update plus its registry entry in _shared/news-sources.ts.
update public.news_sources
set enabled = false,
    last_error = 'Disabled: Reddit blocks Supabase edge IPs with HTTP 403.',
    updated_at = now()
where id = 'reddit-genz';

comment on column public.news_sources.enabled is
  'False for a source that cannot work from here at all, with the reason in last_error. The collector''s registry is the other half of the switch.';
