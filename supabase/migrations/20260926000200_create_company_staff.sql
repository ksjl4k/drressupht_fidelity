-- DressupHT company portal - Step 3: authentication foundation.
--
-- Purpose: give the future company portal a way to tell "this request comes
-- from a real DressupHT employee" without ever exposing the employee list to
-- a browser.
--
-- Design (deliberately minimal - no role/permission matrix yet):
--   public.company_staff is the allow-list of staff Supabase Auth accounts.
--   It gets RLS enabled and *zero* policies, and anon/authenticated get no
--   table privileges at all, so the rows are unreadable from the browser
--   even by a logged-in employee. The only supported server-side question is
--   public.is_company_staff(user_id) below, which is executable by
--   service_role only - i.e. by an Edge Function, never by the browser.
--
-- The future Edge Function flow is then:
--   1. the function verifies the incoming JWT (that is what proves the caller
--      is authenticated, and yields user.id),
--   2. it calls is_company_staff(user.id) using the service-role client,
--   3. it does its work only if that returned true.
-- Nothing in this migration touches customers, purchases, sync-square,
-- square-webhook or hyper-handler.

-- 1. The staff allow-list.
create table if not exists public.company_staff (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  role text not null default 'staff',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.company_staff is
  'Supabase Auth accounts allowed into the DressupHT company portal. Server-side only: no RLS policies, no grants to anon/authenticated.';
comment on column public.company_staff.user_id is
  'auth.users.id of the employee. Deleting the auth user removes the staff row.';

-- 2. Row level security on, with no policies at all: RLS enabled + zero
--    policies denies every non-bypass role, which is exactly what we want.
alter table public.company_staff enable row level security;

-- 3/4. Belt and braces: even if someone later adds a policy by mistake, the
--    browser roles hold no privileges on the table.
revoke all on table public.company_staff from public, anon, authenticated;
grant all on table public.company_staff to service_role;

-- 5. The single server-side question the portal will ask.
--    security definer + fixed search_path: it reads the table as its owner
--    (postgres, which has BYPASSRLS) even though no policy would allow it.
--    stable: it is a read, and the result cannot change inside a statement.
create or replace function public.is_company_staff(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.company_staff s
    where s.user_id = p_user_id
      and s.active
  );
$$;

comment on function public.is_company_staff(uuid) is
  'True when p_user_id is an active company_staff member. Callable by service_role only (Edge Functions); returns false for unknown, non-staff and deactivated users.';

-- service_role only. The browser cannot call it, not even for its own id.
revoke all on function public.is_company_staff(uuid) from public, anon, authenticated;
grant execute on function public.is_company_staff(uuid) to service_role;
