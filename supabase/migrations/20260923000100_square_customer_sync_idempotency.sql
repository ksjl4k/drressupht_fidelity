-- Serialize Square customer creation per Supabase customer row and retain a
-- stable recovery path when a function execution is interrupted.
alter table public.customers
  add column if not exists square_sync_status text not null default 'pending',
  add column if not exists square_sync_claim_token uuid,
  add column if not exists square_sync_lease_until timestamptz;

create unique index if not exists customers_square_customer_id_unique
  on public.customers (square_customer_id)
  where square_customer_id is not null;

create or replace function public.claim_square_customer_sync(
  p_customer_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  customer_row public.customers%rowtype;
begin
  update public.customers
     set square_sync_status = 'processing',
         square_sync_claim_token = p_claim_token,
         square_sync_lease_until = now() + interval '2 minutes'
   where id = p_customer_id
     and square_customer_id is null
     and (
       square_sync_status <> 'processing'
       or square_sync_lease_until is null
       or square_sync_lease_until <= now()
     )
  returning * into customer_row;

  if found then
    return jsonb_build_object('claimed', true, 'customer', to_jsonb(customer_row));
  end if;

  select * into customer_row
    from public.customers
   where id = p_customer_id;

  if not found then
    return jsonb_build_object('claimed', false, 'customer', null);
  end if;

  return jsonb_build_object('claimed', false, 'customer', to_jsonb(customer_row));
end;
$$;

create or replace function public.complete_square_customer_sync(
  p_customer_id uuid,
  p_claim_token uuid,
  p_square_customer_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  customer_row public.customers%rowtype;
begin
  update public.customers
     set square_customer_id = coalesce(square_customer_id, p_square_customer_id),
         square_sync_status = 'completed',
         square_sync_claim_token = null,
         square_sync_lease_until = null
   where id = p_customer_id
     and (
       (square_customer_id is null and square_sync_claim_token = p_claim_token)
       or square_customer_id = p_square_customer_id
     )
  returning * into customer_row;

  if not found then
    select * into customer_row
      from public.customers
     where id = p_customer_id;

    if not found then
      return jsonb_build_object('completed', false, 'square_customer_id', null);
    end if;

    return jsonb_build_object(
      'completed', false,
      'square_customer_id', customer_row.square_customer_id
    );
  end if;

  return jsonb_build_object(
    'completed', customer_row.square_customer_id = p_square_customer_id,
    'square_customer_id', customer_row.square_customer_id
  );
end;
$$;

create or replace function public.release_square_customer_sync(
  p_customer_id uuid,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.customers
     set square_sync_status = case
           when square_customer_id is null then 'failed'
           else 'completed'
         end,
         square_sync_claim_token = null,
         square_sync_lease_until = null
   where id = p_customer_id
     and square_sync_claim_token = p_claim_token;

  return found;
end;
$$;

revoke all on function public.claim_square_customer_sync(uuid, uuid) from public, anon, authenticated;
revoke all on function public.complete_square_customer_sync(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.release_square_customer_sync(uuid, uuid) from public, anon, authenticated;

grant execute on function public.claim_square_customer_sync(uuid, uuid) to service_role;
grant execute on function public.complete_square_customer_sync(uuid, uuid, text) to service_role;
grant execute on function public.release_square_customer_sync(uuid, uuid) to service_role;
