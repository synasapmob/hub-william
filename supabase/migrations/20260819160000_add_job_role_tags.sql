alter table public.job_postings
  add column role_tags text[] not null default '{}';

update public.job_postings
set role_tags = array[category]
where cardinality(role_tags) = 0;

create index job_postings_role_tags_idx
on public.job_postings using gin (role_tags)
where inactive_at is null;

comment on column public.job_postings.role_tags is
  'Overlapping role scopes derived from title and technical evidence. A full-stack React/Go job may belong to software-engineering, frontend, and backend.';
