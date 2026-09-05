-- The first production smoke sync reached the normalized upsert before the
-- private-payload boundary rejected its write. Those rows intentionally have
-- processed_at = null. Retire rather than delete them so the failed run remains
-- auditable; any listing still returned by a source is reactivated and fully
-- processed by the next idempotent sync.
update public.job_postings
set inactive_at = now(),
    updated_at = now()
where processed_at is null
  and inactive_at is null;
