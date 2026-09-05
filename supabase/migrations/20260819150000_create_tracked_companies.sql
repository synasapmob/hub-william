create table public.companies (
  id text primary key,
  name text not null,
  slug text not null unique,
  career_url text not null,
  logo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.company_aliases (
  company_id text not null references public.companies (id) on delete cascade,
  alias text not null,
  canonical_alias text generated always as (
    lower(regexp_replace(alias, '[^a-zA-Z0-9]+', '', 'g'))
  ) stored,
  primary key (company_id, alias),
  unique (canonical_alias)
);

alter table public.job_sources
  add column company_id text references public.companies (id) on delete set null;

alter table public.job_postings
  add column company_id text references public.companies (id) on delete set null;

create index job_postings_company_id_market_idx
on public.job_postings (company_id, category, location_city, posted_at desc nulls last)
where inactive_at is null;

create table public.tracked_companies (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  company_id text not null references public.companies (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (profile_id, company_id)
);

alter table public.companies enable row level security;
alter table public.company_aliases enable row level security;
alter table public.tracked_companies enable row level security;

revoke all on table public.companies from anon, authenticated;
revoke all on table public.company_aliases from anon, authenticated;
revoke all on table public.tracked_companies from anon, authenticated;

grant select on table public.companies to authenticated;
grant select on table public.company_aliases to authenticated;
grant select, insert, delete on table public.tracked_companies to authenticated;

grant all on table public.companies to service_role;
grant all on table public.company_aliases to service_role;
grant all on table public.tracked_companies to service_role;

create policy "Approved users can read companies"
on public.companies for select to authenticated
using ((select public.is_approved_user()));

create policy "Approved users can read company aliases"
on public.company_aliases for select to authenticated
using ((select public.is_approved_user()));

create policy "Approved users can read their tracked companies"
on public.tracked_companies for select to authenticated
using (
  profile_id = (select auth.uid())
  and (select public.is_approved_user())
);

create policy "Approved users can track companies"
on public.tracked_companies for insert to authenticated
with check (
  profile_id = (select auth.uid())
  and (select public.is_approved_user())
);

create policy "Approved users can untrack companies"
on public.tracked_companies for delete to authenticated
using (
  profile_id = (select auth.uid())
  and (select public.is_approved_user())
);

insert into public.companies (id, name, slug, career_url)
values
  ('grab', 'Grab', 'grab', 'https://www.grab.careers/en/jobs/'),
  ('axon', 'Axon', 'axon', 'https://www.axon.com/careers/all'),
  ('nab', 'NAB Vietnam', 'nab-vietnam', 'https://nab.eightfold.ai/careers'),
  ('airwallex', 'Airwallex', 'airwallex', 'https://jobs.ashbyhq.com/airwallex'),
  ('binance', 'Binance', 'binance', 'https://jobs.lever.co/binance'),
  ('supabase', 'Supabase', 'supabase', 'https://jobs.ashbyhq.com/supabase');

insert into public.company_aliases (company_id, alias)
values
  ('grab', 'Grab'),
  ('axon', 'Axon'),
  ('nab', 'NAB'),
  ('nab', 'NAB Vietnam'),
  ('nab', 'National Australia Bank'),
  ('nab', 'National Australia Bank Vietnam'),
  ('airwallex', 'Airwallex'),
  ('binance', 'Binance'),
  ('supabase', 'Supabase');

update public.job_sources
set company_id = case id
  when 'ashby-airwallex' then 'airwallex'
  when 'ashby-supabase' then 'supabase'
  when 'lever-binance' then 'binance'
end
where id in ('ashby-airwallex', 'ashby-supabase', 'lever-binance');

insert into public.job_sources (
  id,
  name,
  source_type,
  source_url,
  requires_secret,
  company_id
)
values
  ('grab-careers', 'Grab Careers', 'grab-rss', 'https://www.grab.careers/en/jobs/', false, 'grab'),
  ('greenhouse-axon', 'Axon Careers', 'greenhouse', 'https://www.axon.com/careers/all', false, 'axon'),
  ('eightfold-nab', 'NAB Careers', 'eightfold', 'https://nab.eightfold.ai/careers', false, 'nab');

update public.job_postings
set company_id = case
  when lower(regexp_replace(company_name, '[^a-zA-Z0-9]+', '', 'g')) = 'grab' then 'grab'
  when lower(regexp_replace(company_name, '[^a-zA-Z0-9]+', '', 'g')) = 'axon' then 'axon'
  when lower(regexp_replace(company_name, '[^a-zA-Z0-9]+', '', 'g')) in (
    'nab',
    'nabvietnam',
    'nationalaustraliabank',
    'nationalaustraliabankvietnam'
  ) then 'nab'
  when lower(regexp_replace(company_name, '[^a-zA-Z0-9]+', '', 'g')) = 'airwallex' then 'airwallex'
  when lower(regexp_replace(company_name, '[^a-zA-Z0-9]+', '', 'g')) = 'binance' then 'binance'
  when lower(regexp_replace(company_name, '[^a-zA-Z0-9]+', '', 'g')) = 'supabase' then 'supabase'
end
where company_id is null;

insert into public.tracked_companies (profile_id, company_id)
select profile.id, company.id
from public.profiles as profile
cross join public.companies as company
where company.id in ('grab', 'axon', 'nab')
on conflict do nothing;

create or replace function public.seed_default_tracked_companies()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.tracked_companies (profile_id, company_id)
  select new.id, company.id
  from public.companies as company
  where company.id in ('grab', 'axon', 'nab')
  on conflict do nothing;

  return new;
end;
$$;

create trigger after_profile_insert_seed_tracked_companies
after insert on public.profiles
for each row execute procedure public.seed_default_tracked_companies();

comment on table public.companies is
  'Canonical employers used to merge ATS feeds and company-name aliases.';

comment on table public.tracked_companies is
  'Owner-scoped employer watchlist; market job data remains shared.';
