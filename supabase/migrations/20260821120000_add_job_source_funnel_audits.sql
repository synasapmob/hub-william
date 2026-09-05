alter table public.job_sync_source_runs
  add column market_jobs_kept integer not null default 0
    check (market_jobs_kept >= 0);

comment on column public.job_sync_source_runs.market_jobs_kept is
  'Jobs remaining after the Vietnam/APAC/true-remote market location filter, before title classification.';
