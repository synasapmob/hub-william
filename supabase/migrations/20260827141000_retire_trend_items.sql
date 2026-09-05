-- The Google Trends rows in news_items were never usable, and now they have a
-- table of their own.
--
-- Every one of them stored the feed's own URL as its url — <link> in that feed
-- is `https://trends.google.com/trending/rss?geo=VN` repeated on every item, not
-- a link to the keyword. Three consequences followed, all confirmed against the
-- live table before this was written:
--
--   * 125 US and 65 VN keywords carried one url_key each, so dedup collapsed
--     them into exactly one cluster per geo. The "also on N other sources" a
--     reader saw on a trends card was counting unrelated keywords.
--   * The detail page had nothing to show: <description> is empty in this feed
--     and the stored payload was only {"geo": "VN"}.
--   * Every one was filed as GenZ, because the connector hardcoded the hint.
--     "giá heo hơi hôm nay" is pork prices.
--
-- They are removed rather than migrated. There is nothing in them to carry
-- across: the keyword survives as the title, and news-sync re-collects it into
-- news_trends within the hour with the traffic and coverage that were being
-- discarded. Leaving them would also feed junk into keyword derivation, whose
-- input is the article corpus.
--
-- Forward-only, as everything here is. If this proves wrong the fix is the next
-- migration, not an undo.
delete from public.news_items
where source_id in ('trends-vn', 'trends-us');

-- Their metrics and payloads go with them by cascade; this is only to leave a
-- record of what the cascade covered.
comment on table public.news_items is
  'Collected articles. Google Trends keywords are not items and live in news_trends — their feed publishes one shared link for every keyword, which made them indistinguishable to URL-based dedup.';
