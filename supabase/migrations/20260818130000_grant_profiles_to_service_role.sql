-- Two service_role grants that were revoked but never re-granted. Both surface
-- as the same misleading failure: the Edge Function catches a PostgREST 42501
-- and answers with its generic public message, so the cause never reaches a log.
--
-- Kept separate from the Claude telemetry migration: this repairs existing gaps
-- and is worth being able to reason about, or revert, on its own.

-- requireApprovedUser() reads public.profiles with the service-role client on
-- every Edge Function action, but profiles was created before the provider
-- tables and never received the grant they all got. The approval check reads
-- the resulting error as "not approved" and returns 403 blaming the account.
grant select on table public.profiles to service_role;

-- The gateway key functions revoke execute from public — which is what removes
-- it from every role, service_role included — and then grant it to no one. The
-- provider tables in the same repository pair each revoke with a grant; these
-- four were left with only half the pair, so creating, listing or revoking a
-- key fails, and so does every codex-gateway request, which resolves its key
-- through the same path.
grant execute on function public.store_gateway_key(text, uuid, text, text) to service_role;
grant execute on function public.resolve_gateway_key(text) to service_role;
grant execute on function public.list_gateway_keys(uuid) to service_role;
grant execute on function public.delete_gateway_key(uuid, uuid) to service_role;
