-- LeetCode, the one source on the wanted list that turned out to be reachable.
--
-- TikTok, LinkedIn and X were checked at the same time and are not: TikTok's
-- Creative Center answers 200 with {"code":40101,"msg":"no permission"} and
-- needs a rendered browser session, LinkedIn puts everything behind an auth
-- wall, and x.com/explore returns a 67-byte JavaScript shell while the API
-- costs money. LeetCode's GraphQL endpoint answers an unauthenticated POST with
-- real data, so it is the only one that becomes a connector rather than a
-- scraping project.
--
-- Two items a day and change: the daily challenge, whose topicTags are the
-- actual reason to collect it — "Hash Table", "Sliding Window" and the rest
-- feed Stack keyword derivation — plus whichever contests are upcoming, which
-- repeat until they run and dedup into updates on their slug.
--
-- Weighted below the news sources deliberately. A daily puzzle is reliably
-- there, which is the opposite of newsworthy, and it should not outrank a
-- layoff filing simply for being punctual.
insert into public.news_sources (
  id, name, source_type, source_url, category, category_exclusive, weight
)
values
  (
    'leetcode-daily',
    'LeetCode daily and contests',
    'leetcode',
    'https://leetcode.com',
    'stack',
    true,
    0.60
  )
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
