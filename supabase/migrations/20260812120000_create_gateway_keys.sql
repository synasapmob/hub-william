-- API keys that let a local Codex CLI reach the hub's gateway, which then
-- fans the request out across the owner's connected Codex accounts.
--
-- Only the SHA-256 of a key is ever stored, and generation happens in the Edge
-- Function rather than here: hashing client-side keeps the plaintext out of the
-- Postgres wire protocol and its logs entirely, so "shown once at creation" is
-- a property of the system and not a UI convention.

create table private.gateway_keys (
  key_hash text primary key,
  owner_id uuid not null references public.profiles (id) on delete cascade
);

create index gateway_keys_owner_idx on private.gateway_keys (owner_id);

-- private is unreachable from PostgREST (config.toml exposes only public and
-- graphql_public), so every access goes through a definer function, matching
-- how provider_credentials is bridged.

create or replace function public.store_gateway_key(
  p_key_hash text,
  p_owner_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required';
  end if;

  insert into private.gateway_keys (key_hash, owner_id)
  values (p_key_hash, p_owner_id);
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

-- Regeneration is delete-then-store, so revocation takes every key the owner
-- has rather than a single hash the caller would have to know.
create or replace function public.delete_gateway_keys(p_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required';
  end if;

  delete from private.gateway_keys
  where owner_id = p_owner_id;
end;
$$;

-- Lets the dashboard render "a key exists" without the row itself, which is
-- the most the UI is ever allowed to learn after the one-time reveal.
create or replace function public.gateway_key_exists(p_owner_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required';
  end if;

  return exists (
    select 1
    from private.gateway_keys as key
    where key.owner_id = p_owner_id
  );
end;
$$;

revoke all on function public.store_gateway_key(text, uuid) from public, anon, authenticated;
revoke all on function public.resolve_gateway_key(text) from public, anon, authenticated;
revoke all on function public.delete_gateway_keys(uuid) from public, anon, authenticated;
revoke all on function public.gateway_key_exists(uuid) from public, anon, authenticated;
