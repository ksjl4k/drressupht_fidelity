import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const SQUARE_ACCESS_TOKEN = Deno.env.get("SQUARE_ACCESS_TOKEN")!;
const SQUARE_ENVIRONMENT = Deno.env.get("SQUARE_ENVIRONMENT") || "sandbox";
const SQUARE_API_URL = SQUARE_ENVIRONMENT === "production" 
  ? "https://connect.squareup.com/v2" 
  : "https://connect.squareupsandbox.com/v2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const payload = await req.json();
    const record = payload.record;
    if (!record) {
      return new Response(JSON.stringify({ error: "No customer record provided" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { id, dressup_member_id, first_name, last_name, phone, email, birthday } = record;

    // 1. Create Customer in Square Customer Directory
    const squareRes = await fetch(`${SQUARE_API_URL}/customers`, {
      method: "POST",
      headers: {
        "Square-Version": "2026-09-16",
        "Authorization": `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        // Use a unique key based on phone number so duplicate requests from the same user are ignored by Square
        idempotency_key: `cust_${phone.replace(/[^0-9]/g, '')}`,
        given_name: first_name,
        family_name: last_name,
        email_address: email || undefined,
        phone_number: phone,
        reference_id: dressup_member_id,
        note: `DressupHT Fidelity ID: ${dressup_member_id}`
      })
    });

    const squareData = await squareRes.json();
    if (!squareRes.ok) {
      console.error("Square API Error:", squareData);
      return new Response(JSON.stringify({ error: squareData }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const squareCustomerId = squareData.customer.id;

    // 2. Update Supabase record with Square Customer ID
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    await supabaseAdmin
      .from("customers")
      .update({ square_customer_id: squareCustomerId })
      .eq("id", id);

    return new Response(JSON.stringify({ success: true, squareCustomerId }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400
    });
  }
});