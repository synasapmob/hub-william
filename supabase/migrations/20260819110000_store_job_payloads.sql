create or replace function public.store_job_payloads(p_payloads jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required';
  end if;

  if jsonb_typeof(p_payloads) <> 'array' then
    raise exception 'job payloads must be an array';
  end if;

  insert into private.job_posting_payloads as stored (
    job_posting_id,
    raw_payload,
    updated_at
  )
  select
    (payload ->> 'job_posting_id')::uuid,
    payload -> 'raw_payload',
    now()
  from jsonb_array_elements(p_payloads) as payload
  on conflict (job_posting_id) do update
  set raw_payload = excluded.raw_payload,
      updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.store_job_payloads(jsonb) from public, anon, authenticated;
grant execute on function public.store_job_payloads(jsonb) to service_role;

comment on function public.store_job_payloads(jsonb) is
  'Service-role bridge for batching raw job payloads into the unexposed private schema.';
