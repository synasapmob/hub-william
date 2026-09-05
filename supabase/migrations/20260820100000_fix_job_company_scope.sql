drop trigger if exists after_profile_insert_seed_tracked_companies
on public.profiles;

drop function if exists public.seed_default_tracked_companies();
drop table if exists public.tracked_companies;

update public.job_sources
set enabled = false,
    updated_at = now()
where id in ('ashby-airwallex', 'ashby-supabase', 'lever-binance');

delete from public.companies
where id not in (
  'tyme-group',
  'smg',
  'digital-unicorn',
  'manulife',
  'axon',
  'grab',
  'corsair',
  'masan-group',
  'moatable',
  'worldquant',
  'nab',
  'employment-hero',
  'vinsmart-future'
);

insert into public.companies (id, name, slug, career_url)
values
  ('tyme-group', 'Tyme Group', 'tyme-group', 'https://tymegroup.io/careers'),
  ('smg', 'SMG Swiss Marketplace Group', 'smg-swiss-marketplace-group', 'https://swissmarketplace.group/career/'),
  ('digital-unicorn', 'Digital Unicorn', 'digital-unicorn', 'https://digitalunicorn.fr/'),
  ('manulife', 'Manulife', 'manulife', 'https://careers.manulife.com/global/en'),
  ('axon', 'Axon', 'axon', 'https://www.axon.com/careers/all'),
  ('grab', 'Grab', 'grab', 'https://www.grab.careers/en/jobs/'),
  ('corsair', 'Corsair', 'corsair', 'https://www.corsair.com/us/en/s/careers'),
  ('masan-group', 'Masan Group', 'masan-group', 'https://www.masangroup.com/'),
  ('moatable', 'Moatable', 'moatable', 'https://www.moatable.com/careers/'),
  ('worldquant', 'WorldQuant', 'worldquant', 'https://www.worldquant.com/career-listing/'),
  ('nab', 'NAB Vietnam', 'nab-vietnam', 'https://nab.eightfold.ai/careers'),
  ('employment-hero', 'Employment Hero', 'employment-hero', 'https://employmenthero.com/careers/'),
  ('vinsmart-future', 'VinSmart Future', 'vinsmart-future', 'https://vinsmartfuture.com/careers')
on conflict (id) do update
set name = excluded.name,
    slug = excluded.slug,
    career_url = excluded.career_url,
    updated_at = now();

insert into public.company_aliases (company_id, alias)
values
  ('tyme-group', 'Tyme'),
  ('tyme-group', 'Tyme Group'),
  ('smg', 'SMG'),
  ('smg', 'Swiss Marketplace Group'),
  ('smg', 'SMG Swiss Marketplace Group'),
  ('digital-unicorn', 'Digital Unicorn'),
  ('manulife', 'Manulife'),
  ('manulife', 'Manulife Vietnam'),
  ('axon', 'Axon'),
  ('axon', 'Axon Enterprise'),
  ('grab', 'Grab'),
  ('corsair', 'Corsair'),
  ('corsair', 'Corsair Gaming'),
  ('masan-group', 'Masan'),
  ('masan-group', 'Masan Group'),
  ('moatable', 'Moatable'),
  ('worldquant', 'WorldQuant'),
  ('worldquant', 'WorldQuant Vietnam'),
  ('nab', 'NAB'),
  ('nab', 'NAB Vietnam'),
  ('nab', 'National Australia Bank'),
  ('nab', 'National Australia Bank Vietnam'),
  ('employment-hero', 'Employment Hero'),
  ('vinsmart-future', 'VinSmart'),
  ('vinsmart-future', 'VinSmart Future')
on conflict do nothing;

update public.job_postings as posting
set company_id = alias.company_id,
    updated_at = now()
from public.company_aliases as alias
where lower(regexp_replace(posting.company_name, '[^a-zA-Z0-9]+', '', 'g')) = alias.canonical_alias
  and posting.company_id is distinct from alias.company_id;

comment on table public.companies is
  'The fixed employer set used by the Jobs dashboard and synchronization pipeline.';
