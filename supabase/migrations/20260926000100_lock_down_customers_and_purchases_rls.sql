-- DressupHT loyalty portal - Step 2: lock down public access to customer data.
--
-- State found in the live database before this migration (created outside
-- version control, so it was invisible to the repo):
--   RLS enabled on both tables, but gated by permissive policies:
--     customers : "Allow public insert on customers"      INSERT, anon+authenticated
--     customers : "Allow public select on customers"      SELECT true, anon+authenticated
--     purchases : "Allow public read access on purchases" SELECT true, PUBLIC
--   plus Supabase's default "grant all on public.* to anon, authenticated".
-- Net effect: anyone holding the public publishable key could read every
-- customer's name, phone, email, birthday and Square customer id, and could
-- update or delete rows. purchases was readable by every role in the cluster.
--
-- Target state after this migration:
--   anon          INSERT customers  - public registration keeps working
--   anon          SELECT customers  - only the row it just inserted itself
--   anon          SELECT purchases  - denied (no policy, no privilege)
--   authenticated nothing yet      - staff policies land in the next step
--   service_role  unchanged         - has BYPASSRLS, so the Edge Functions
--                                     (sync-square, square-webhook) and the
--                                     security-definer sync RPCs are unaffected
--
-- Why the SELECT policy is not simply dropped: script.js registers with
-- .insert({...}).select().single(), which makes PostgREST send
-- "Prefer: return=representation". RETURNING is evaluated under the SELECT
-- policies, so removing SELECT entirely would insert the row and then return
-- nothing, and .single() would raise PGRST116 - registration would break.
-- So the insert tags its own row with a transaction-local setting
-- (dressupht.inserted_customer_ids) from a BEFORE INSERT trigger, and the
-- SELECT policy exposes only those ids. The setting is transaction-scoped, so
-- COMMIT/ROLLBACK discards it and it cannot leak into a later request;
-- PostgREST exposes no way for a client to set it; and the ids are uuid4, so
-- the only row an anonymous caller can ever read back is the one it just
-- created itself. Replacing this with a register_customer(...) RPC is the
-- cleaner end state, but that requires changing the registration client and is
-- out of scope for this step.

-- 1. RLS must be active on both tables (already is; kept idempotent).
alter table public.customers enable row level security;
alter table public.purchases enable row level security;

-- 2. Remove the permissive policies that exposed customer data.
drop policy if exists "Allow public select on customers" on public.customers;
drop policy if exists "Allow public insert on customers" on public.customers;
drop policy if exists "Allow public read access on purchases" on public.purchases;

-- 3. Drop the blanket table privileges and hand back only what public
--    registration needs. Defence in depth: even if a future policy is written
--    too widely, the privileges still bound what anon/authenticated can do.
revoke all on table public.customers from anon, authenticated;
revoke all on table public.purchases from anon, authenticated;
grant insert, select on table public.customers to anon, authenticated;
grant all on table public.customers, public.purchases to service_role;

-- 4. Tag each inserted row with its id for the lifetime of the transaction.
create or replace function public.mark_dressupht_inserted_customer()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  already_tagged text;
begin
  already_tagged := current_setting('dressupht.inserted_customer_ids', true);
  perform set_config(
    'dressupht.inserted_customer_ids',
    concat_ws(',', nullif(already_tagged, ''), new.id::text),
    true
  );

  return new;
end;
$$;

revoke all on function public.mark_dressupht_inserted_customer() from public;
grant execute on function public.mark_dressupht_inserted_customer()
  to anon, authenticated, service_role;

drop trigger if exists dressupht_mark_inserted_customer on public.customers;
create trigger dressupht_mark_inserted_customer
  before insert on public.customers
  for each row
  execute function public.mark_dressupht_inserted_customer();

-- 5. Policies.
--    purchases deliberately gets none: no SELECT/INSERT/UPDATE/DELETE for
--    anon or authenticated until the staff-facing step defines them.
drop policy if exists customers_public_insert on public.customers;
create policy customers_public_insert
  on public.customers
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists customers_read_just_inserted on public.customers;
create policy customers_read_just_inserted
  on public.customers
  for select
  to anon, authenticated
  using (
    case
      when nullif(current_setting('dressupht.inserted_customer_ids', true), '') is null
        then false
      else id = any (
        string_to_array(current_setting('dressupht.inserted_customer_ids', true), ',')::uuid[]
      )
    end
  );
