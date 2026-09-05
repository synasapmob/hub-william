-- YouTube, which is the whole of the MEDIA tab and deliberately so.
--
-- X, LinkedIn and TikTok were each probed for this and none of them can be
-- collected without a logged-in session: x.com/explore returns a 67-byte
-- JavaScript shell and the API has cost money since 2023, LinkedIn walls its
-- feed, and TikTok's Creative Center answers 200 with
-- {"code":40101,"msg":"no permission"}. Scraping any of them means driving a
-- browser signed in as a real account, which is how accounts get banned. So
-- MEDIA is built from the one thing that publishes openly.
--
-- YouTube gives every channel an Atom feed at
-- /feeds/videos.xml?channel_id=... with no key and no quota. Fifteen entries,
-- titles and publish dates — enough for the feed and, more usefully, enough for
-- keyword derivation to work on video titles.
--
-- Channel ids are canonical, taken from each channel's own rel="canonical"
-- link rather than the first UC id on its @handle page. That distinction
-- matters: the handle page surfaces featured channels, and resolving that way
-- returned "Beyond Fireship" (last upload January 2025) and "Theo Rants" (last
-- upload December 2024) instead of the main channels. Both would have passed a
-- reachability check and then silently contributed nothing, because fetchRss
-- drops anything older than 21 days.
insert into public.news_sources (
  id, name, source_type, source_url, category, category_exclusive, weight
)
values
  ('yt-fireship',     'Fireship',         'youtube', 'https://www.youtube.com/@Fireship',     'media', true, 1.00),
  ('yt-theo',         'Theo - t3.gg',     'youtube', 'https://www.youtube.com/@t3dotgg',      'media', true, 0.90),
  ('yt-primeagen',    'ThePrimeagen',     'youtube', 'https://www.youtube.com/@ThePrimeagen', 'media', true, 0.90),
  ('yt-mkbhd',        'Marques Brownlee', 'youtube', 'https://www.youtube.com/@mkbhd',        'media', true, 0.80),
  ('yt-networkchuck', 'NetworkChuck',     'youtube', 'https://www.youtube.com/@NetworkChuck', 'media', true, 0.70),
  ('yt-arjancodes',   'ArjanCodes',       'youtube', 'https://www.youtube.com/@ArjanCodes',   'media', true, 0.70)
on conflict (id) do update
set name = excluded.name,
    source_type = excluded.source_type,
    source_url = excluded.source_url,
    category = excluded.category,
    category_exclusive = excluded.category_exclusive,
    weight = excluded.weight,
    enabled = true,
    last_error = null,
    updated_at = now();
