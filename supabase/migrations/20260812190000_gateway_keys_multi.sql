-- One key per owner becomes many: the hub is shared with other people, so each
-- of them gets their own key that can be revoked without disturbing the rest.
--
-- The plaintext is still never stored. What is added is only enough to tell one
-- key from another after the single reveal: a label the owner chose and a hint
-- built from the key's own visible ends (hw_sk_ab12…wXyZ). The hint is not a
-- secret — it is 8 characters of a 43-character random tail, which identifies a
-- row without narrowing a brute force in any useful way.

alter table private.gateway_keys
  add column id uuid not null default gen_random_uuid(),
  add column label text,
  add column hint text,
  add column created_at timestamptz not null default now();

-- Rows that predate this migration were revealed under the old single-key flow,
-- so their hint cannot be recovered from a hash. They get an honest placeholder
-- rather than a fabricated prefix.
update private.gateway_keys
set label = coalesce(label, 'Original key'),
    hint = coalesce(hint, 'hw_sk_…');

alter table private.gateway_keys
  alter column label set not null,
  alter column hint set not null,
  add constraint gateway_keys_label_length
    check (char_length(label) between 1 and 60);

-- key_hash stops being the identity: the dashboard has to address a key to
-- revoke it, and it must never learn the hash to do so.
alter table private.gateway_keys drop constraint gateway_keys_pkey;
alter table private.gateway_keys alter column key_hash set not null;
alter table private.gateway_keys add primary key (id);
alter table private.gateway_keys
  add constraint gateway_keys_key_hash_key unique (key_hash);

drop function if exists public.store_gateway_key(text, uuid);
drop function if exists public.delete_gateway_keys(uuid);
drop function if exists public.gateway_key_exists(uuid);

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

-- The gateway's hot path: one lookup per proxied request.
create or replace function public.resolve_gateway_key(p_key_hash text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required';
  end if;

  select key.owner_id into v_owner_id
  from private.gateway_keys as key
  where key.key_hash = p_key_hash;

  return v_owner_id;
end;
$$;

-- Everything the dashboard is allowed to know about existing keys. key_hash is
-- deliberately absent: it is the only stored value an attacker could use.
create or replace function public.list_gateway_keys(p_owner_id uuid)
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

  return query
  select key.id, key.label, key.hint, key.created_at
  from private.gateway_keys as key
  where key.owner_id = p_owner_id
  order by key.created_at asc;
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

  delete from private.gateway_keys as key
  where key.id = p_key_id and key.owner_id = p_owner_id;

  get diagnostics v_deleted = row_count;

  return v_deleted > 0;
end;
$$;

revoke all on function public.store_gateway_key(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.resolve_gateway_key(text) from public, anon, authenticated;
revoke all on function public.list_gateway_keys(uuid) from public, anon, authenticated;
revoke all on function public.delete_gateway_key(uuid, uuid) from public, anon, authenticated;
