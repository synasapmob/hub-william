-- Three roles behind one question: who may mint a gateway key. A key reaches
-- every account this hub has connected and every request it proxies is billed
-- to them, so handing one out is an owner's decision rather than something the
-- dashboard does. Until now any approved profile could do it, because approval
-- was the only distinction the schema had.
--
-- moderator is named here with no privilege of its own. Adding the middle value
-- later would mean altering the enum, the badge and every check that reads it;
-- naming it now costs one line and leaves somewhere for the next distinction to
-- go. status keeps governing access to the workspace at all, so a pending admin
-- is still locked out — the two columns answer different questions.

create type public.app_user_role as enum ('admin', 'moderator', 'member');

alter table public.profiles
  add column role public.app_user_role not null default 'member';

comment on column public.profiles.role is
  'admin creates and revokes gateway keys. moderator and member cannot. Access to the workspace is governed separately by status.';

-- The owner is whoever registered first: every other profile exists because
-- they approved it. Without this the migration would hand a hub full of keys to
-- nobody, including the person who set it up, and the only way back would be
-- editing a role by hand before the dashboard could mint anything again.
update public.profiles
set role = 'admin'
where id = (
  select id
  from public.profiles
  order by created_at asc
  limit 1
);

-- The two gateway key functions gain the same check. They run as service_role,
-- where auth.uid() is null, so neither can ask who the caller is — the owner id
-- the Edge Function passes is the only identity available, and it is the one
-- the key would belong to. The Edge Function checks the role first and answers
-- 403; this exists so a future caller that forgets to cannot mint a key anyway.

create or replace function public.store_gateway_key(
  p_key_hash text,
  p_owner_id uuid,
  p_label text,
  p_hint text
)
returns table (
  id uuid,
  label text,
  hint text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required';
  end if;

  if not exists (
    select 1
    from public.profiles as profile
    where profile.id = p_owner_id
      and profile.status = 'approved'
      and profile.role = 'admin'
  ) then
    raise exception 'gateway keys require an admin profile';
  end if;

  -- A ceiling so a retry loop or a stuck button cannot fill the table. Well
  -- above any plausible number of people to share a personal hub with.
  if (
    select count(*) from private.gateway_keys as key where key.owner_id = p_owner_id
  ) >= 20 then
    raise exception 'gateway key limit reached';
  end if;

  return query
  insert into private.gateway_keys as key (key_hash, owner_id, label, hint)
  values (p_key_hash, p_owner_id, p_label, p_hint)
  returning key.id, key.label, key.hint, key.created_at;
end;
$$;

-- Scoped to the owner in the same statement as the id, so a caller holding a
-- guessed id still cannot delete someone else's key.
create or replace function public.delete_gateway_key(
  p_owner_id uuid,
  p_key_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required';
  end if;

  if not exists (
    select 1
    from public.profiles as profile
    where profile.id = p_owner_id
      and profile.status = 'approved'
      and profile.role = 'admin'
  ) then
    raise exception 'gateway keys require an admin profile';
  end if;

  delete from private.gateway_keys as key
  where key.id = p_key_id and key.owner_id = p_owner_id;

  get diagnostics v_deleted = row_count;

  return v_deleted > 0;
end;
$$;

-- create or replace keeps the existing privileges, but a replaced function is
-- exactly where a missing grant goes unnoticed until an Edge Function answers
-- 500, so both are restated rather than assumed.
revoke all on function public.store_gateway_key(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.delete_gateway_key(uuid, uuid) from public, anon, authenticated;

grant execute on function public.store_gateway_key(text, uuid, text, text) to service_role;
grant execute on function public.delete_gateway_key(uuid, uuid) to service_role;
