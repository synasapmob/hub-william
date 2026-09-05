-- Three sources that arrive by hand rather than by connector.
--
-- LinkedIn, X and TikTok answer a login wall to any request without a session,
-- so news-sync has no connector for them and never will: x.com/explore returns
-- a 67-byte JavaScript shell, LinkedIn walls its feed, and TikTok's Creative
-- Center answers 200 with {"code":40101,"msg":"no permission"}. They are read
-- by scripts/collect-social.mjs from a signed-in browser and posted to the
-- news-ingest function.
--
-- Registered here so they appear in source health beside the others, and so
-- news-ingest can refuse anything claiming to be a source that does not exist.
-- Their last_synced_at will lag the automated sources, which is correct — they
-- update when somebody runs the script, not on the hour.
insert into public.news_sources (
  id, name, source_type, source_url, category, category_exclusive, weight
)
values
  ('linkedin-feed', 'LinkedIn feed (manual)',   'ingested', 'https://www.linkedin.com/feed/', 'stack', false, 0.70),
  ('x-timeline',    'X timeline (manual)',      'ingested', 'https://x.com/home',             null,    false, 0.70),
  ('tiktok-trends', 'TikTok trends VN (manual)','ingested', 'https://ads.tiktok.com',         'genz',  true,  0.90)
on conflict (id) do update
set name = excluded.name,
    source_type = excluded.source_type,
    source_url = excluded.source_url,
    category = excluded.category,
    category_exclusive = excluded.category_exclusive,
    weight = excluded.weight,
    enabled = true,
    updated_at = now();

comment on column public.news_sources.source_type is
  'How the source is read. Everything but ''ingested'' is a connector in news-sync; ''ingested'' arrives from scripts/collect-social.mjs via the news-ingest function, because the site requires a signed-in browser.';
