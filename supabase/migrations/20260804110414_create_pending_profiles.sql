create type public.app_user_status as enum ('pending', 'approved');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  status public.app_user_status not null default 'pending',
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Private Hub William profiles. The owner approves access by changing status to approved.';

alter table public.profiles enable row level security;

revoke all on table public.profiles from anon;
revoke all on table public.profiles from authenticated;
grant select on table public.profiles to authenticated;

create policy "Users can read their own profile"
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.set_profile_timestamps()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at = now();

  if new.status = 'approved' and old.status = 'pending' then
    new.approved_at = now();
  elsif new.status = 'pending' then
    new.approved_at = null;
  end if;

  return new;
end;
$$;

create trigger before_profile_update
before update on public.profiles
for each row execute procedure public.set_profile_timestamps();

create or replace function public.is_approved_user()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and status = 'approved'
  );
$$;

revoke all on function public.is_approved_user() from public;
grant execute on function public.is_approved_user() to authenticated;
