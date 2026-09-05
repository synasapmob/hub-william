-- A derived keyword could be inserted an unlimited number of times.
--
-- news_trends declared `unique (term_key, category, geo)`, and geo is null for
-- every keyword derived from articles — only Google's regional searches carry
-- one. In Postgres a unique constraint treats nulls as distinct, so two rows
-- with the same term_key and category and a null geo do not conflict. The
-- constraint was never enforcing anything for the origin that needed it most.
--
-- The collector's upsert names that same constraint as its conflict target, so
-- it never matched either: instead of updating Tuesday's "llama.cpp" it
-- inserted a second one, and an hourly job would have added 156 rows an hour
-- forever. The first run after deploy already produced exact pairs — two
-- "LLM", two "Generation", two "Qwen3.8" — differing only in the hotness
-- recomputed microseconds apart.
--
-- Postgres 15 added NULLS NOT DISTINCT for exactly this. The project is on
-- 17.6, so the fix is the declaration the table should have had.

-- Derived keywords are cheap to rebuild — the next collection re-derives all of
-- them from news_items in seconds — so the duplicates go rather than trying to
-- pick a survivor. Coverage, terms and metrics cascade with them.
delete from public.news_trends where origin = 'coverage';

alter table public.news_trends
  drop constraint news_trends_term_key_category_geo_key;

alter table public.news_trends
  add constraint news_trends_term_key_category_geo_key
  unique nulls not distinct (term_key, category, geo);

comment on constraint news_trends_term_key_category_geo_key on public.news_trends is
  'NULLS NOT DISTINCT because geo is null for every derived keyword. Without it the constraint silently exempts exactly the rows it exists to protect, and the collector''s upsert degrades into an insert.';
