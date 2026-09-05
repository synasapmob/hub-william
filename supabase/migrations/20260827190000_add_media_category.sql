-- A fourth category, for what people watch rather than what they read.
--
-- Added on its own because Postgres refuses to use a new enum value in the same
-- transaction that adds it. The sources that use it arrive in the next
-- migration.
alter type public.news_category add value if not exists 'media';
