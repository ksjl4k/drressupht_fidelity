-- DressupHT loyalty points - Step 5: DressupHT-owned loyalty ledger.
--
-- Architecture decision (deliberate, and different from the PDF):
--   The PDF stored the points balance in Square Loyalty. We are NOT doing that.
--   DressupHT/Supabase is now the ledger and the single source of truth for
--   points. Square Retail remains the source of truth for customers, catalog,
--   orders, payments and sales history only.
--   There is deliberately NO square_loyalty_account_id column anywhere, and
--   nothing in this migration or its functions talks to /v2/loyalty/*.
--
-- Rules implemented verbatim from
--   DressupHT_Implementation_Fidelite_Square.pdf (pages 1-5):
--
--   total <= 30 USD                          -> 0 points, nothing else
--   total  > 30 USD                          -> ROUND(eligible x 0.05 x rate)
--   excluded item or variation               -> removed from eligible amount
--   birthday purchase, total <= 100 USD      -> + 5 x rate
--   birthday purchase, total >  100 USD      -> + 10 x rate
--   referred customer's first eligible purchase
--                                            -> referrer gets
--                                               ROUND(eligible x 0.05 x rate)
--   rounding                                 -> nearest integer
--
--   The rate is a row in loyalty_settings, never a literal in the formula, as
--   the PDF requires ("parametre modifiable ... et non une valeur codee en dur").
--
-- Ledger model: append-only. customers.cashback_balance is NOT used and NOT
-- trusted; the balance is always
--     SUM(points awarded) - SUM(points deducted/reversed)
-- over loyalty_transactions.points, which is stored signed (awards positive,
-- deductions and reversals negative). Every row carries the exchange rate and
-- the eligible USD amount that produced it, plus a unique idempotency_key so a
-- replayed Square webhook can never credit the same order twice.

-- ---------------------------------------------------------------------------
-- 1. Configurable parameters (singleton row).
-- ---------------------------------------------------------------------------
create table if not exists public.loyalty_settings (
  singleton boolean primary key default true check (singleton),
  -- 1 point = 1 GDS of DressupHT credit; points per 1 USD of eligible spend.
  exchange_rate integer not null default 140 check (exchange_rate > 0),
  cashback_rate numeric(6, 4) not null default 0.05 check (cashback_rate > 0),
  -- Orders at or below this amount create no points at all.
  min_purchase_usd numeric(12, 2) not null default 30 check (min_purchase_usd >= 0),
  -- Birthday bonus thresholds, expressed in USD of credit before conversion.
  birthday_threshold_usd numeric(12, 2) not null default 100 check (birthday_threshold_usd >= 0),
  birthday_bonus_low_usd numeric(12, 2) not null default 5 check (birthday_bonus_low_usd >= 0),
  birthday_bonus_high_usd numeric(12, 2) not null default 10 check (birthday_bonus_high_usd >= 0),
  updated_at timestamptz not null default now()
);

comment on table public.loyalty_settings is
  'Single row of DressupHT loyalty parameters. exchange_rate is the configurable DressupHT rate (points per USD); the award function never hard-codes it.';
comment on column public.loyalty_settings.singleton is
  'Always true. Keeps the table a one-row configuration.';

insert into public.loyalty_settings (singleton) values (true) on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2. Non-eligible Square catalog objects.
-- ---------------------------------------------------------------------------
create table if not exists public.loyalty_excluded_catalog_objects (
  catalog_object_id text primary key,
  label text,
  created_at timestamptz not null default now()
);

comment on table public.loyalty_excluded_catalog_objects is
  'Square catalog item or variation ids that earn 0 points. Matched against line_items[].catalog_object_id and line_items[].item_id of a Square order.';

-- ---------------------------------------------------------------------------
-- 3. The append-only ledger.
-- ---------------------------------------------------------------------------
create table if not exists public.loyalty_transactions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  purchase_id uuid references public.purchases (id) on delete set null,
  square_order_id text,
  -- What the row represents.
  entry_type text not null check (entry_type in (
    'cashback',        -- normal 5% award
    'birthday_bonus',  -- birthday bonus
    'referral_bonus',  -- bonus granted to the referrer
    'deduction',       -- points spent on a reward
    'reversal',        -- points taken back (refund / cancelled order)
    'adjustment'       -- manual correction
  )),
  -- Signed: positive credits the customer, negative debits them. This is the
  -- only place a balance is derived from, so the balance is always auditable.
  points integer not null check (points <> 0),
  -- Exactly what the formula consumed, kept for auditing and replays.
  eligible_usd numeric(12, 2),
  exchange_rate integer not null check (exchange_rate > 0),
  reason text,
  -- Replay protection: the same logical award always produces the same key.
  idempotency_key text not null unique,
  -- Set on reversal/deduction rows to point at what is being undone.
  reverses_id uuid references public.loyalty_transactions (id),
  created_at timestamptz not null default now()
);

create index if not exists loyalty_transactions_customer_idx
  on public.loyalty_transactions (customer_id, created_at desc);
create index if not exists loyalty_transactions_order_idx
  on public.loyalty_transactions (square_order_id);

comment on table public.loyalty_transactions is
  'DressupHT points ledger (source of truth). Balance = sum(points). Append-only; corrections are new negative rows.';
comment on column public.loyalty_transactions.idempotency_key is
  'Unique replay guard, e.g. order:<square_order_id>:cashback. A duplicate Square webhook cannot credit an order twice.';

-- ---------------------------------------------------------------------------
-- 4. Lock-down, identical pattern to company_staff: RLS on, zero policies, no
--    browser privileges. Customers can never read their own ledger, and the
--    company portal reaches it only through service_role.
-- ---------------------------------------------------------------------------
alter table public.loyalty_settings enable row level security;
alter table public.loyalty_excluded_catalog_objects enable row level security;
alter table public.loyalty_transactions enable row level security;

revoke all on table public.loyalty_settings from public, anon, authenticated;
revoke all on table public.loyalty_excluded_catalog_objects from public, anon, authenticated;
revoke all on table public.loyalty_transactions from public, anon, authenticated;
grant all on table public.loyalty_settings to service_role;
grant all on table public.loyalty_excluded_catalog_objects to service_role;
grant all on table public.loyalty_transactions to service_role;

-- ---------------------------------------------------------------------------
-- 6. Read helpers. All of them are SECURITY DEFINER and executable by
--    service_role only, so the only caller is the protected company backend.
-- ---------------------------------------------------------------------------
create or replace function public.customer_points_balance(p_customer_id uuid)
returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(sum(t.points), 0)::bigint
  from public.loyalty_transactions t
  where t.customer_id = p_customer_id;
$$;

create or replace function public.customer_loyalty_summary(p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_awarded bigint;
  v_deducted bigint;
  v_eligible bigint;
  v_count integer;
  v_last timestamptz;
  v_rate integer;
begin
  select coalesce(sum(points) filter (where points > 0), 0)::bigint,
         coalesce(sum(points) filter (where points < 0), 0)::bigint,
         count(*)::integer,
         max(created_at)
    into v_awarded, v_deducted, v_count, v_last
  from public.loyalty_transactions
  where customer_id = p_customer_id;

  -- Points earned from eligible spending, net of the reversals of those
  -- awards. This is the reward progression: spending points on a reward does
  -- not lower it, unlike points_balance which is the spendable balance.
  select coalesce(sum(t.points), 0)::bigint into v_eligible
  from public.loyalty_transactions t
  where t.customer_id = p_customer_id
    and (
      (t.points > 0 and t.entry_type in ('cashback', 'birthday_bonus', 'referral_bonus'))
      or (t.points < 0 and t.entry_type = 'reversal')
    );

  select exchange_rate into v_rate from public.loyalty_settings limit 1;

  -- current_balance = SUM(points awarded) - SUM(points deducted/reversed)
  return jsonb_build_object(
    'points_balance', coalesce(v_awarded, 0) + coalesce(v_deducted, 0),
    'eligible_points', coalesce(v_eligible, 0),
    'lifetime_awarded', coalesce(v_awarded, 0),
    'lifetime_deducted', coalesce(v_deducted, 0),
    'transactions_count', coalesce(v_count, 0),
    'exchange_rate', coalesce(v_rate, 140),
    'last_activity_at', v_last,
    'status', 'active'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. The award engine: applies the PDF rules to one recorded purchase.
--
--    It is idempotent, so it is safe to call on every Square order webhook
--    delivery: each award is keyed by order id, and a second delivery of the
--    same order inserts nothing.
--
--    It refuses to guess. If the recorded purchase is missing the data the
--    rules need (USD currency, line items, line items that add up to the order
--    total), it awards nothing and says why, instead of inventing a number.
-- ---------------------------------------------------------------------------
create or replace function public.award_dressupht_loyalty_for_purchase(
  p_purchase_id uuid,
  p_options jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_purchase public.purchases%rowtype;
  v_customer public.customers%rowtype;
  v_referrer public.customers%rowtype;
  v_settings public.loyalty_settings%rowtype;
  v_line jsonb;
  v_line_total numeric(14, 4);
  v_ids text[];
  v_total numeric(14, 4);
  v_sum_lines numeric(14, 4) := 0;
  v_eligible numeric(14, 4) := 0;
  v_excluded_count integer := 0;
  v_missing_amount boolean := false;
  v_points integer;
  v_birthday_points integer := 0;
  v_referral_points integer := 0;
  v_birthday boolean := false;
  v_is_birthday_purchase boolean := false;
  v_first_purchase boolean;
  v_dup_accounts integer;
  v_new_id uuid;
  v_referral jsonb := '{"status": "not_applicable"}'::jsonb;
  v_inserted jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_result jsonb;
  v_refunded boolean := coalesce((p_options ->> 'is_refund')::boolean, false);
begin
  -- Reuse the reversal path when the caller reports a refund.
  if v_refunded then
    return public.reverse_dressupht_loyalty_for_purchase(
      p_purchase_id,
      coalesce(p_options ->> 'reason', 'refund')
    );
  end if;

  select * into v_purchase from public.purchases where id = p_purchase_id;
  if not found then
    return jsonb_build_object('status', 'skipped', 'reason', 'purchase_not_found');
  end if;

  if v_purchase.square_order_id is null or btrim(v_purchase.square_order_id) = '' then
    return jsonb_build_object('status', 'skipped', 'reason', 'missing_square_order_id');
  end if;

  if v_purchase.customer_id is null then
    return jsonb_build_object('status', 'skipped', 'reason', 'purchase_without_customer');
  end if;

  select * into v_customer from public.customers where id = v_purchase.customer_id;
  if not found then
    return jsonb_build_object('status', 'skipped', 'reason', 'customer_not_found');
  end if;

  -- The rules are expressed in USD. A purchase in another currency cannot be
  -- converted safely here, so it is skipped rather than mis-valued.
  if coalesce(v_purchase.currency, '') <> 'USD' then
    return jsonb_build_object(
      'status', 'skipped',
      'reason', 'currency_not_usd',
      'currency', v_purchase.currency
    );
  end if;

  if v_purchase.total_amount is null or v_purchase.total_amount <= 0 then
    return jsonb_build_object('status', 'skipped', 'reason', 'non_positive_total');
  end if;

  if v_purchase.items is null or jsonb_typeof(v_purchase.items) <> 'array'
     or jsonb_array_length(v_purchase.items) = 0 then
    return jsonb_build_object('status', 'skipped', 'reason', 'missing_line_items');
  end if;

  select * into v_settings from public.loyalty_settings limit 1;

  -- Has this customer been paid cashback on an earlier order? Decided before
  -- this order's own cashback row is written, otherwise every order would look
  -- like a repeat visit and the referral bonus would never be granted.
  select not exists (
    select 1 from public.loyalty_transactions
    where customer_id = v_customer.id
      and entry_type in ('cashback', 'birthday_bonus')
  ) into v_first_purchase;

  v_total := round(v_purchase.total_amount::numeric, 2);

  -- Walk the Square line items: money is in cents, and a line is ineligible
  -- when its catalog object (variation or parent item) is on the exclusion list.
  for v_line in select value from jsonb_array_elements(v_purchase.items)
  loop
    if v_line -> 'total_money' ->> 'amount' is null then
      v_missing_amount := true;
    else
      v_line_total := (v_line -> 'total_money' ->> 'amount')::numeric / 100.0;
      v_sum_lines := v_sum_lines + v_line_total;

      v_ids := array_remove(array[
        nullif(v_line ->> 'catalog_object_id', ''),
        nullif(v_line ->> 'item_id', '')
      ], null);

      if exists (
        select 1 from public.loyalty_excluded_catalog_objects e
        where e.catalog_object_id = any (v_ids)
      ) then
        v_excluded_count := v_excluded_count + 1;
      else
        v_eligible := v_eligible + v_line_total;
      end if;
    end if;
  end loop;

  if v_missing_amount then
    return jsonb_build_object(
      'status', 'skipped',
      'reason', 'line_missing_total_money',
      'square_order_id', v_purchase.square_order_id
    );
  end if;

  -- The line items must reconstruct the order total, otherwise the purchase
  -- does not carry enough information to apply the rules. An explicit
  -- p_options->>'allow_line_mismatch' opt-in exists for orders that carry an
  -- order-level discount Square does not repeat on the lines.
  if abs(round(v_sum_lines, 2) - v_total) > 0.01
     and not coalesce((p_options ->> 'allow_line_mismatch')::boolean, false) then
    return jsonb_build_object(
      'status', 'skipped',
      'reason', 'line_items_do_not_match_total',
      'order_total_usd', v_total,
      'line_items_sum_usd', round(v_sum_lines, 2)
    );
  end if;

  v_eligible := round(v_eligible, 2);

  -- PDF: an order of 30 USD or less creates no points at all.
  if v_total <= v_settings.min_purchase_usd then
    return jsonb_build_object(
      'status', 'skipped',
      'reason', 'at_or_below_minimum_purchase',
      'square_order_id', v_purchase.square_order_id,
      'total_usd', v_total,
      'minimum_usd', v_settings.min_purchase_usd,
      'exchange_rate', v_settings.exchange_rate
    );
  end if;

  -- ---- normal cashback -----------------------------------------------------
  v_points := round(v_eligible * v_settings.cashback_rate * v_settings.exchange_rate)::integer;

  insert into public.loyalty_transactions (
    customer_id, purchase_id, square_order_id, entry_type, points,
    eligible_usd, exchange_rate, reason, idempotency_key
  ) values (
    v_customer.id, v_purchase.id, v_purchase.square_order_id, 'cashback', v_points,
    v_eligible, v_settings.exchange_rate,
    format('cashback %s x %s x %s', v_eligible, v_settings.cashback_rate, v_settings.exchange_rate),
    'order:' || v_purchase.square_order_id || ':cashback'
  )
  on conflict (idempotency_key) do nothing
  returning id into v_new_id;

  if v_new_id is null then
    v_skipped := v_skipped || jsonb_build_object('entry_type', 'cashback', 'reason', 'already_recorded');
  else
    v_inserted := v_inserted || jsonb_build_object('entry_type', 'cashback', 'points', v_points, 'transaction_id', v_new_id);
  end if;

  -- ---- birthday bonus ------------------------------------------------------
  -- The PDF states the bonus amounts but not how a purchase is flagged as the
  -- birthday purchase, so it is derived from the customer's own birthday
  -- (customers.birthday is stored as JJ/MM) matching the purchase month, and
  -- can be forced or suppressed per call with p_options->>'is_birthday'.
  if p_options ? 'is_birthday' then
    v_birthday := coalesce((p_options ->> 'is_birthday')::boolean, false);
  elsif v_customer.birthday ~ '^\d{2}/\d{2}$' then
    v_birthday := extract(month from v_purchase.created_at)::integer
                  = right(v_customer.birthday, 2)::integer;
  end if;
  v_is_birthday_purchase := v_birthday;

  if v_birthday then
    if v_total <= v_settings.birthday_threshold_usd then
      v_birthday_points := round(v_settings.birthday_bonus_low_usd * v_settings.exchange_rate)::integer;
    else
      v_birthday_points := round(v_settings.birthday_bonus_high_usd * v_settings.exchange_rate)::integer;
    end if;

    insert into public.loyalty_transactions (
      customer_id, purchase_id, square_order_id, entry_type, points,
      eligible_usd, exchange_rate, reason, idempotency_key
    ) values (
      v_customer.id, v_purchase.id, v_purchase.square_order_id, 'birthday_bonus', v_birthday_points,
      v_eligible, v_settings.exchange_rate,
      format('birthday bonus (%s USD order)', v_total),
      'order:' || v_purchase.square_order_id || ':birthday'
    )
    on conflict (idempotency_key) do nothing
    returning id into v_new_id;

    if v_new_id is null then
      v_skipped := v_skipped || jsonb_build_object('entry_type', 'birthday_bonus', 'reason', 'already_recorded');
    else
      v_inserted := v_inserted || jsonb_build_object('entry_type', 'birthday_bonus', 'points', v_birthday_points, 'transaction_id', v_new_id);
    end if;
  end if;

  -- ---- referral bonus for the referrer -------------------------------------
  if v_customer.referred_by is not null and btrim(v_customer.referred_by) <> '' then
    if v_customer.referral_reward_used then
      v_referral := jsonb_build_object('status', 'already_used');
    elsif v_customer.dressup_member_id is not null
          and btrim(v_customer.referred_by) = btrim(v_customer.dressup_member_id) then
      v_referral := jsonb_build_object('status', 'blocked_self_referral');
    else
      select * into v_referrer
      from public.customers
      where dressup_member_id = btrim(v_customer.referred_by)
      limit 1;

      if not found then
        v_referral := jsonb_build_object('status', 'referrer_not_found', 'referred_by', v_customer.referred_by);
      elsif v_referrer.id = v_customer.id then
        v_referral := jsonb_build_object('status', 'blocked_self_referral');
      elsif v_referrer.phone is not null and v_customer.phone is not null
            and regexp_replace(v_referrer.phone, '\D', '', 'g')
              = regexp_replace(v_customer.phone, '\D', '', 'g') then
        v_referral := jsonb_build_object('status', 'blocked_same_phone_as_referrer');
      else
        -- Only the referred customer's first eligible purchase pays the bonus.
        if not v_first_purchase then
          v_referral := jsonb_build_object('status', 'not_first_eligible_purchase');
        else
          -- Anti-abuse: the same phone number must not be sitting on several
          -- accounts, otherwise the bonus could be farmed with re-registrations.
          select count(*)::integer into v_dup_accounts
          from public.customers
          where phone is not null
            and regexp_replace(phone, '\D', '', 'g')
              = regexp_replace(v_customer.phone, '\D', '', 'g');

          if v_dup_accounts > 1 then
            v_referral := jsonb_build_object('status', 'blocked_duplicate_accounts', 'accounts_with_same_phone', v_dup_accounts);
          else
            v_referral := jsonb_build_object('status', 'eligible', 'referrer_member_id', v_referrer.dressup_member_id);

            v_referral_points := round(v_eligible * v_settings.cashback_rate * v_settings.exchange_rate)::integer;

            insert into public.loyalty_transactions (
              customer_id, purchase_id, square_order_id, entry_type, points,
              eligible_usd, exchange_rate, reason, idempotency_key
            ) values (
              v_referrer.id, v_purchase.id, v_purchase.square_order_id, 'referral_bonus', v_referral_points,
              v_eligible, v_settings.exchange_rate,
              format('referral bonus for %s', v_referrer.dressup_member_id),
              'order:' || v_purchase.square_order_id || ':referral:' || v_referrer.id::text
            )
            on conflict (idempotency_key) do nothing
            returning id into v_new_id;

            if v_new_id is null then
              v_skipped := v_skipped || jsonb_build_object('entry_type', 'referral_bonus', 'reason', 'already_recorded');
            else
              v_inserted := v_inserted || jsonb_build_object('entry_type', 'referral_bonus', 'points', v_referral_points, 'referrer_customer_id', v_referrer.id, 'transaction_id', v_new_id);
              -- Mark the referral as spent so a later order can never pay it twice.
              update public.customers
                 set referral_reward_used = true
               where id = v_customer.id;
            end if;
          end if;
        end if;
      end if;
    end if;
  end if;

  v_result := jsonb_build_object(
    'status', case when v_inserted = '[]'::jsonb then 'no_new_awards' else 'awarded' end,
    'purchase_id', v_purchase.id,
    'square_order_id', v_purchase.square_order_id,
    'customer_id', v_customer.id,
    'total_usd', v_total,
    'eligible_usd', v_eligible,
    'excluded_line_count', v_excluded_count,
    'exchange_rate', v_settings.exchange_rate,
    'cashback_rate', v_settings.cashback_rate,
    'cashback_points', v_points,
    'is_birthday_purchase', v_is_birthday_purchase,
    'birthday_points', v_birthday_points,
    'referral', v_referral,
    'referral_points', v_referral_points,
    'points_balance', public.customer_points_balance(v_customer.id),
    'awarded', v_inserted,
    'skipped', v_skipped
  );

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Reversal: a refunded or cancelled order takes the points back.
--    Idempotent as well, and it never re-opens a spent referral.
-- ---------------------------------------------------------------------------
create or replace function public.reverse_dressupht_loyalty_for_purchase(
  p_purchase_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_purchase public.purchases%rowtype;
  v_original public.loyalty_transactions%rowtype;
  v_new_id uuid;
  v_reversed integer := 0;
  v_already integer := 0;
begin
  select * into v_purchase from public.purchases where id = p_purchase_id;
  if not found then
    return jsonb_build_object('status', 'skipped', 'reason', 'purchase_not_found');
  end if;

  if v_purchase.square_order_id is null then
    return jsonb_build_object('status', 'skipped', 'reason', 'missing_square_order_id');
  end if;

  select count(*)::integer into v_already
  from public.loyalty_transactions t
  where t.square_order_id = v_purchase.square_order_id
    and t.points > 0
    and exists (
      select 1 from public.loyalty_transactions r where r.reverses_id = t.id
    );

  for v_original in
    select t.* from public.loyalty_transactions t
    where t.square_order_id = v_purchase.square_order_id
      and t.points > 0
      and not exists (
        select 1 from public.loyalty_transactions r
        where r.reverses_id = t.id
      )
    order by t.created_at
  loop
    insert into public.loyalty_transactions (
      customer_id, purchase_id, square_order_id, entry_type, points,
      eligible_usd, exchange_rate, reason, idempotency_key, reverses_id
    ) values (
      v_original.customer_id, v_original.purchase_id, v_original.square_order_id,
      'reversal', -v_original.points, v_original.eligible_usd, v_original.exchange_rate,
      coalesce(p_reason, 'reversal of ' || v_original.entry_type),
      'order:' || v_original.square_order_id || ':reversal:' || v_original.idempotency_key,
      v_original.id
    )
    on conflict (idempotency_key) do nothing
    returning id into v_new_id;

    if v_new_id is not null then
      v_reversed := v_reversed + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'status', case when v_reversed = 0 then 'nothing_to_reverse' else 'reversed' end,
    'square_order_id', v_purchase.square_order_id,
    'reversed_count', v_reversed,
    'already_reversed_count', v_already,
    'reason', p_reason
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Redemption: points spent on a reward. The caller supplies the key so a
--    retried request cannot spend the same points twice.
-- ---------------------------------------------------------------------------
create or replace function public.redeem_dressupht_points(
  p_customer_id uuid,
  p_points integer,
  p_idempotency_key text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_balance bigint;
  v_rate integer;
  v_new_id uuid;
begin
  if p_points is null or p_points <= 0 then
    return jsonb_build_object('status', 'rejected', 'reason', 'points_must_be_positive');
  end if;

  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    return jsonb_build_object('status', 'rejected', 'reason', 'idempotency_key_required');
  end if;

  if not exists (select 1 from public.customers where id = p_customer_id) then
    return jsonb_build_object('status', 'rejected', 'reason', 'customer_not_found');
  end if;

  v_balance := public.customer_points_balance(p_customer_id);
  if v_balance < p_points then
    return jsonb_build_object(
      'status', 'rejected',
      'reason', 'insufficient_points',
      'points_balance', v_balance,
      'requested', p_points
    );
  end if;

  select exchange_rate into v_rate from public.loyalty_settings limit 1;

  insert into public.loyalty_transactions (
    customer_id, entry_type, points, exchange_rate, reason, idempotency_key
  ) values (
    p_customer_id, 'deduction', -p_points, coalesce(v_rate, 140),
    coalesce(p_reason, 'redemption'), btrim(p_idempotency_key)
  )
  on conflict (idempotency_key) do nothing
  returning id into v_new_id;

  if v_new_id is null then
    return jsonb_build_object('status', 'already_recorded', 'points_balance', v_balance);
  end if;

  return jsonb_build_object(
    'status', 'redeemed',
    'points_deducted', p_points,
    'points_balance', public.customer_points_balance(p_customer_id),
    'transaction_id', v_new_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Backfill report. Read-only: it says which recorded purchases could be
--     scored safely and what they would be worth, and writes nothing. Granting
--     points for past orders is a commercial decision, so it stays explicit.
-- ---------------------------------------------------------------------------
create or replace function public.dressupht_loyalty_backfill_candidates()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  r record;
  v_settings public.loyalty_settings%rowtype;
  v_line jsonb;
  v_ids text[];
  v_sum numeric(14, 4) := 0;
  v_eligible numeric(14, 4) := 0;
  v_total numeric(14, 4);
  v_status text;
  v_reason text;
  v_would jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  select * into v_settings from public.loyalty_settings limit 1;

  for r in
    select p.id, p.square_order_id, p.total_amount, p.currency, p.items, p.created_at
    from public.purchases p
    order by p.created_at
  loop
    v_total := round(r.total_amount::numeric, 2);
    v_sum := 0;
    v_eligible := 0;
    v_status := 'awardable';
    v_reason := null;

    if r.square_order_id is null then
      v_status := 'skipped'; v_reason := 'missing_square_order_id';
    elsif coalesce(r.currency, '') <> 'USD' then
      v_status := 'skipped'; v_reason := 'currency_not_usd';
    elsif r.items is null or jsonb_typeof(r.items) <> 'array' or jsonb_array_length(r.items) = 0 then
      v_status := 'skipped'; v_reason := 'missing_line_items';
    else
      for v_line in select value from jsonb_array_elements(r.items)
      loop
        v_sum := v_sum + ((v_line -> 'total_money' ->> 'amount')::numeric / 100.0);
        v_ids := array_remove(array[
          nullif(v_line ->> 'catalog_object_id', ''),
          nullif(v_line ->> 'item_id', '')
        ], null);
        if not exists (
          select 1 from public.loyalty_excluded_catalog_objects e
          where e.catalog_object_id = any (v_ids)
        ) then
          v_eligible := v_eligible + ((v_line -> 'total_money' ->> 'amount')::numeric / 100.0);
        end if;
      end loop;

      if abs(round(v_sum, 2) - v_total) > 0.01 then
        v_status := 'skipped'; v_reason := 'line_items_do_not_match_total';
      elsif v_total <= v_settings.min_purchase_usd then
        v_status := 'skipped'; v_reason := 'at_or_below_minimum_purchase';
      elsif exists (
        select 1 from public.loyalty_transactions t
        where t.square_order_id = r.square_order_id
      ) then
        v_status := 'skipped'; v_reason := 'already_scored';
      end if;
    end if;

    v_would := case when v_status = 'awardable' then
      jsonb_build_object(
        'cashback_points', round(round(v_eligible, 2) * v_settings.cashback_rate * v_settings.exchange_rate)::integer
      )
    else '{}'::jsonb end;

    v_out := v_out || jsonb_build_object(
      'purchase_id', r.id,
      'square_order_id', r.square_order_id,
      'total_usd', v_total,
      'eligible_usd', round(v_eligible, 2),
      'status', v_status,
      'reason', v_reason,
      'would_award', v_would
    );
  end loop;

  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Grants: service_role only. No browser role can read the ledger, the
--     settings or the exclusion list, and no customer can read their own
--     balance. The company portal gets there through the protected function.
-- ---------------------------------------------------------------------------
revoke all on function public.customer_points_balance(uuid) from public, anon, authenticated;
revoke all on function public.customer_loyalty_summary(uuid) from public, anon, authenticated;
revoke all on function public.award_dressupht_loyalty_for_purchase(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.reverse_dressupht_loyalty_for_purchase(uuid, text) from public, anon, authenticated;
revoke all on function public.redeem_dressupht_points(uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.dressupht_loyalty_backfill_candidates() from public, anon, authenticated;

grant execute on function public.customer_points_balance(uuid) to service_role;
grant execute on function public.customer_loyalty_summary(uuid) to service_role;
grant execute on function public.award_dressupht_loyalty_for_purchase(uuid, jsonb) to service_role;
grant execute on function public.reverse_dressupht_loyalty_for_purchase(uuid, text) to service_role;
grant execute on function public.redeem_dressupht_points(uuid, integer, text, text) to service_role;
grant execute on function public.dressupht_loyalty_backfill_candidates() to service_role;
