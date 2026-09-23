import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const { record } = await req.json();
    if (!record) {
      return new Response(JSON.stringify({ error: "No customer record provided" }), { status: 400 });
    }

    const SQUARE_ACCESS_TOKEN = Deno.env.get("SQUARE_ACCESS_TOKEN");
    const SQUARE_ENVIRONMENT = Deno.env.get("SQUARE_ENVIRONMENT") || "sandbox"; // "production" or "sandbox"
    
    // Choose correct Square API URL based on environment
    const squareBaseUrl = SQUARE_ENVIRONMENT === "production" 
      ? "https://connect.squareup.com" 
      : "https://connect.squareupsandbox.com";

    // 1. Prepare Customer Data for Square API
    const squareCustomerData = {
      idempotency_key: crypto.randomUUID(),
      given_name: record.first_name,
      family_name: record.last_name || "",
      phone_number: record.phone || "",
      email_address: record.email || undefined,
      reference_id: record.dressup_member_id,
      note: `DressupHT Loyalty Member ID: ${record.dressup_member_id}`
    };

    // 2. Call Square API to create/sync customer
    const squareResponse = await fetch(`${squareBaseUrl}/v2/customers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Square-Version": "2024-01-18",
        "Authorization": `Bearer ${SQUARE_ACCESS_TOKEN}`
      },
      body: JSON.stringify(squareCustomerData)
    });

    const squareResult = await squareResponse.json();

    if (!squareResponse.ok) {
      console.error("Square API Error:", squareResult);
      return new Response(JSON.stringify({ error: "Failed to sync with Square", details: squareResult }), { 
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Extract Square's customer ID from the response
    const squareCustomerId = squareResult.customer?.id;

    if (squareCustomerId) {
      // Initialize Supabase Admin Client to update the record with square_customer_id
      const supabaseAdmin = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
      );

      await supabaseAdmin
        .from("customers")
        .update({ square_customer_id: squareCustomerId })
        .eq("id", record.id);
    }

    return new Response(JSON.stringify({ success: true, square_customer_id: squareCustomerId }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });

  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});