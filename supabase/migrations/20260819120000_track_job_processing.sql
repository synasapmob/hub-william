alter table public.job_postings
  add column processed_at timestamptz;

comment on column public.job_postings.processed_at is
  'Set only after skills and the private raw payload persist successfully. Null rows are retried even when their content hash is unchanged.';
