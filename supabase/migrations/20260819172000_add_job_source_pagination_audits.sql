alter table public.job_sync_source_runs
  add column coverage_status text not null default 'unknown'
    check (coverage_status in ('complete', 'partial', 'unknown')),
  add column expected_jobs integer
    check (expected_jobs is null or expected_jobs >= 0),
  add column raw_jobs_fetched integer not null default 0
    check (raw_jobs_fetched >= 0),
  add column unique_jobs_fetched integer not null default 0
    check (unique_jobs_fetched >= 0),
  add column duplicate_jobs integer not null default 0
    check (duplicate_jobs >= 0),
  add column pages_fetched integer not null default 0
    check (pages_fetched >= 0),
  add column page_size integer
    check (page_size is null or page_size > 0),
  add column stop_reason text,
  add column deactivation_allowed boolean not null default false;

comment on column public.job_sync_source_runs.coverage_status is
  'Whether the connector proved it collected the full upstream inventory, collected only a known subset, or cannot prove completeness.';

comment on column public.job_sync_source_runs.deactivation_allowed is
  'True only when coverage evidence is complete, allowing missing postings to advance toward inactive status.';
