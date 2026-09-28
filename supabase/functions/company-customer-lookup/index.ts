import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// DressupHT company portal - customer lookup by DressupHT Member ID.
//
// Deployed with --no-verify-jwt (this project's convention, because
// sync-square/square-webhook are called by the database and by Square), so
// this function verifies the caller itself. The chain is:
//
//   1. the caller must send "Authorization: Bearer <Supabase Auth access token>"
//   2. the token is validated by the Supabase Auth server (signature, expiry,
//      audience) via auth.getUser() - the publishable/anon key is only the
//      credential used to talk to that endpoint, it never identifies a user
//   3. the authenticated user id is checked with public.is_company_staff(),
//      which is executable by service_role only
//
// The browser never sees the service-role key: it is read from the function's
// own environment and used only server-side here.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Only the columns the portal needs. Listing them explicitly means internal
// sync bookkeeping (square_sync_claim_token, square_sync_lease_until,
// square_sync_status, ...) and the cashback balance cannot leak even if the
// schema changes later.
const CUSTOMER_COLUMNS =
  "id, dressup_member_id, first_name, last_name, phone, email, birthday, created_at, square_customer_id";

// The loyalty block is returned as a whitelisted projection of
// public.customer_loyalty_summary(). Customers cannot read the ledger or call
// that function themselves (no grants, zero RLS policies), so this staff-only
// function is the only way the balance reaches the portal, and it exposes
// summary numbers only - never individual ledger rows.
const LOYALTY_FIELDS = [
  "points_balance",
  "eligible_points",
  "lifetime_awarded",
  "lifetime_deducted",
  "transactions_count",
  "exchange_rate",
  "last_activity_at",
  "status",
] as const;

type LoyaltySummary = {
  points_balance: number;
  eligible_points: number;
  lifetime_awarded: number;
  lifetime_deducted: number;
  transactions_count: number;
  exchange_rate: number;
  last_activity_at: string | null;
  status: string;
};

const pickLoyalty = (raw: unknown): LoyaltySummary => {
  const source = (raw ?? {}) as Record<string, unknown>;
  const num = (key: (typeof LOYALTY_FIELDS)[number]) => {
    const value = source[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  return {
    points_balance: num("points_balance"),
    eligible_points: num("eligible_points"),
    lifetime_awarded: num("lifetime_awarded"),
    lifetime_deducted: num("lifetime_deducted"),
    transactions_count: num("transactions_count"),
    exchange_rate: num("exchange_rate"),
    last_activity_at:
      typeof source.last_activity_at === "string" ? source.last_activity_at : null,
    status: typeof source.status === "string" ? source.status : "unknown",
  };
};

const MAX_MEMBER_ID_LENGTH = 128;

serve(async (req) => {
  // Browser CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Supabase function credentials are not configured");
    return json({ error: "Server configuration error" }, 500);
  }

  try {
    // ---- 1. The caller's Supabase Auth access token ------------------------
    const authorization = req.headers.get("Authorization") ?? "";
    const accessToken = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";

    if (!accessToken) {
      return json({ error: "Missing Authorization header" }, 401);
    }

    // ---- 2. Verify the token with the Auth server --------------------------
    // The anon key is used purely as the API credential for this call; the
    // identity comes from the user's access token, never from the anon key.
    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userError } = await authClient.auth.getUser();

    if (userError || !userData?.user?.id) {
      console.error("Rejected access token:", userError?.message ?? "no user");
      return json({ error: "Invalid or expired access token" }, 401);
    }

    const user = userData.user;

    // ---- 3. Is this authenticated user active company staff? ---------------
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: isStaff, error: staffError } = await supabaseAdmin.rpc(
      "is_company_staff",
      { p_user_id: user.id }
    );

    if (staffError) {
      console.error("Staff check failed:", staffError.message);
      return json({ error: "Server error" }, 500);
    }

    if (!isStaff) {
      return json({ error: "Company staff access required" }, 403);
    }

    // ---- 4. Validate the requested member id ------------------------------
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const { member_id: rawMemberId } = (body ?? {}) as { member_id?: unknown };

    if (typeof rawMemberId !== "string") {
      return json({ error: "member_id is required and must be a string" }, 400);
    }

    // Only member_id is read: any other field (filters, ids, select lists) in
    // the body is ignored, so the caller cannot turn this into a general query.
    const memberId = rawMemberId.trim();

    if (!memberId) {
      return json({ error: "member_id cannot be empty" }, 400);
    }

    if (memberId.length > MAX_MEMBER_ID_LENGTH) {
      return json({ error: "member_id is too long" }, 400);
    }

    // ---- 5. Exact member id lookup -----------------------------------------
    const { data: customer, error: lookupError } = await supabaseAdmin
      .from("customers")
      .select(CUSTOMER_COLUMNS)
      .eq("dressup_member_id", memberId)
      .limit(1)
      .maybeSingle();

    if (lookupError) {
      console.error("Customer lookup failed:", lookupError.message);
      return json({ error: "Server error" }, 500);
    }

    if (!customer) {
      return json({ error: "Customer not found" }, 404);
    }

    // ---- 6. Loyalty progression, straight from the DressupHT ledger ----------
    // The balance is always derived from loyalty_transactions (service_role
    // only), never from the legacy customers.cashback_balance column, and it
    // comes from DressupHT - there is no Square Loyalty lookup anywhere here.
    const { data: loyaltyRaw, error: loyaltyError } = await supabaseAdmin.rpc(
      "customer_loyalty_summary",
      { p_customer_id: customer.id }
    );

    if (loyaltyError) {
      // Failing loudly beats showing a balance of 0 that happens to be wrong.
      console.error("Loyalty summary failed:", loyaltyError.message);
      return json({ error: "Server error" }, 500);
    }

    return json({ customer, loyalty: pickLoyalty(loyaltyRaw) }, 200);
  } catch (err) {
    // Log the real cause server-side; never return it to the caller.
    console.error(
      "company-customer-lookup error:",
      err instanceof Error ? err.message : String(err)
    );
    return json({ error: "Server error" }, 500);
  }
});
