-- The news corpus is a rolling queue, not an archive. Keep the newest one
-- hundred articles in every category so an active source cannot grow the
-- database without bound or crowd out a quieter category.

create index news_items_retention_idx
on public.news_items (
  category,
  effective_at desc,
  first_seen_at desc,
  id desc
);

-- Feed APIs repeat their recent history on every collection. A deleted item's
-- full row, metrics, payload, and article text are all expensive, but keeping
-- its small source/external-id pair briefly prevents that old item being
-- inserted and immediately evicted again on the next fetch.
create table private.news_item_tombstones (
  source_id text not null references public.news_sources (id) on delete cascade,
  external_id text not null,
  retired_at timestamptz not null default now(),
  primary key (source_id, external_id)
);

create index news_item_tombstones_expiry_idx
on private.news_item_tombstones (retired_at);

alter table private.news_item_tombstones enable row level security;

revoke all on table private.news_item_tombstones from anon, authenticated;
grant all on table private.news_item_tombstones to service_role;

-- This function has one job: evict every article after the first 100 in each
-- category and preserve only the identity needed to ignore it on later fetches.
-- It is also used by the migration below to reduce the existing backlog.
create or replace function public.prune_news_items()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  -- All news writers take this lock for their entire database transaction, so
  -- one collector cannot prune another collector's unfinished item.
  perform pg_advisory_xact_lock(
    hashtextextended('public.news_items.write', 0)
  );

  with ranked as (
    select
      id,
      source_id,
      external_id,
      row_number() over (
        partition by category
        -- effective_at is the news timestamp; last_seen_at changes on every
        -- collection and would keep a repeatedly fetched old article forever.
        order by effective_at desc, first_seen_at desc, id desc
      ) as position
    from public.news_items
  ),
  tombstoned as (
    insert into private.news_item_tombstones (
      source_id,
      external_id,
      retired_at
    )
    select source_id, external_id, now()
    from ranked
    where position > 100
    on conflict (source_id, external_id) do update
    set retired_at = excluded.retired_at
  ),
  deleted as (
    delete from public.news_items as item
    using ranked
    where item.id = ranked.id
      and ranked.position > 100
    returning 1
  )
  select count(*)::integer into deleted_count from deleted;

  return deleted_count;
end;
$$;

-- Upserting the item, writing its dependent rows, and enforcing retention have
-- to be one transaction. news-sync needs to write metrics/payloads after an
-- upsert; a separate prune call could otherwise remove that parent first.
create or replace function public.store_news_items(
  p_items jsonb,
  p_metrics jsonb,
  p_payloads jsonb
)
returns table (stored_external_id text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'service role required';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'news items must be an array';
  end if;

  if jsonb_typeof(p_metrics) is distinct from 'array' then
    raise exception 'news metrics must be an array';
  end if;

  if jsonb_typeof(p_payloads) is distinct from 'array' then
    raise exception 'news payloads must be an array';
  end if;

  -- Hold the same lock through the upsert, all dependent writes, and prune.
  perform pg_advisory_xact_lock(
    hashtextextended('public.news_items.write', 0)
  );

  -- A source is unlikely to repeat something it retired more than two weeks
  -- ago. Expiring the identities keeps this anti-churn table bounded too.
  delete from private.news_item_tombstones
  where retired_at < now() - interval '14 days';

  with input as (
    select *
    from jsonb_to_recordset(p_items) as item (
      source_id text,
      external_id text,
      url text,
      canonical_url text,
      url_key text,
      title text,
      title_key text,
      author text,
      excerpt text,
      category public.news_category,
      category_reason text,
      cluster_id uuid,
      points integer,
      comments integer,
      attention numeric,
      velocity numeric,
      hotness numeric,
      half_life_hours numeric,
      published_at timestamptz,
      effective_at timestamptz,
      last_seen_at timestamptz,
      content_hash text,
      parser_version text,
      updated_at timestamptz
    )
  ),
  active_input as (
    select input.*
    from input
    where not exists (
      select 1
      from private.news_item_tombstones as tombstone
      where tombstone.source_id = input.source_id
        and tombstone.external_id = input.external_id
    )
  )
  insert into public.news_items as item (
    source_id,
    external_id,
    url,
    canonical_url,
    url_key,
    title,
    title_key,
    author,
    excerpt,
    category,
    category_reason,
    cluster_id,
    points,
    comments,
    attention,
    velocity,
    hotness,
    half_life_hours,
    published_at,
    effective_at,
    last_seen_at,
    content_hash,
    parser_version,
    updated_at
  )
  select
    source_id,
    external_id,
    url,
    canonical_url,
    url_key,
    title,
    title_key,
    author,
    excerpt,
    category,
    category_reason,
    cluster_id,
    points,
    comments,
    attention,
    velocity,
    hotness,
    half_life_hours,
    published_at,
    effective_at,
    last_seen_at,
    content_hash,
    parser_version,
    updated_at
  from active_input
  on conflict (source_id, external_id) do update
  set url = excluded.url,
      canonical_url = excluded.canonical_url,
      url_key = excluded.url_key,
      title = excluded.title,
      title_key = excluded.title_key,
      author = excluded.author,
      excerpt = excluded.excerpt,
      category = excluded.category,
      category_reason = excluded.category_reason,
      cluster_id = excluded.cluster_id,
      points = excluded.points,
      comments = excluded.comments,
      attention = excluded.attention,
      velocity = excluded.velocity,
      hotness = excluded.hotness,
      half_life_hours = excluded.half_life_hours,
      published_at = excluded.published_at,
      effective_at = excluded.effective_at,
      last_seen_at = excluded.last_seen_at,
      content_hash = excluded.content_hash,
      parser_version = excluded.parser_version,
      updated_at = excluded.updated_at;

  insert into public.news_item_metrics as metric (
    item_id,
    captured_at,
    attention
  )
  select
    item.id,
    source.captured_at,
    source.attention
  from jsonb_to_recordset(p_metrics) as source (
    source_id text,
    external_id text,
    captured_at timestamptz,
    attention numeric
  )
  join public.news_items as item
    on item.source_id = source.source_id
   and item.external_id = source.external_id
  on conflict (item_id, captured_at) do update
  set attention = excluded.attention;

  insert into private.news_item_payloads as stored (
    item_id,
    raw_payload,
    updated_at
  )
  select
    item.id,
    payload.raw_payload,
    now()
  from jsonb_to_recordset(p_payloads) as payload (
    source_id text,
    external_id text,
    raw_payload jsonb
  )
  join public.news_items as item
    on item.source_id = payload.source_id
   and item.external_id = payload.external_id
  on conflict (item_id) do update
  set raw_payload = excluded.raw_payload,
      updated_at = excluded.updated_at;

  perform public.prune_news_items();

  -- Report only input rows that survived the final retention pass. The caller
  -- uses this to avoid calling an immediately evicted historical row "stored".
  return query
  select item.external_id as stored_external_id
  from public.news_items as item
  join jsonb_to_recordset(p_items) as source (
    source_id text,
    external_id text
  )
    on item.source_id = source.source_id
   and item.external_id = source.external_id;
end;
$$;

revoke all on function public.prune_news_items() from public, anon, authenticated;
grant execute on function public.prune_news_items() to service_role;

revoke all on function public.store_news_items(jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.store_news_items(jsonb, jsonb, jsonb)
  to service_role;

-- Apply the same cap to the existing backlog rather than waiting for the next
-- collection run.
select public.prune_news_items();

comment on table private.news_item_tombstones is
  'Recent identities of evicted news items, retained for 14 days to prevent repeated feed entries from being reinserted.';

comment on function public.prune_news_items() is
  'Retains the newest 100 news_items per category and removes older rows with their dependent private data.';

comment on function public.store_news_items(jsonb, jsonb, jsonb) is
  'Atomically stores a news batch, its metrics and payloads, then applies per-category retention.';
