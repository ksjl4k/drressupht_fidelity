import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  // Handle browser CORS preflight request
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }

  // Only allow POST requests
  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  let activeClaim: { customerId: string; claimToken: string } | null = null;

  try {
    const { record } = await req.json();

    if (!record || typeof record.id !== "string") {
      return new Response(
        JSON.stringify({
          error: "A customer record with an ID is required",
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    const SQUARE_ACCESS_TOKEN = Deno.env.get("SQUARE_ACCESS_TOKEN");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const SQUARE_ENVIRONMENT =
      Deno.env.get("SQUARE_ENVIRONMENT") || "sandbox";

    if (!SQUARE_ACCESS_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Square or Supabase service credentials are not configured");
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const claimToken = crypto.randomUUID();
    const { data: claimResult, error: claimError } = await supabaseAdmin.rpc(
      "claim_square_customer_sync",
      {
        p_customer_id: record.id,
        p_claim_token: claimToken,
      }
    );

    if (claimError) {
      throw new Error(`Could not claim Square sync: ${claimError.message}`);
    }

    const customer = claimResult?.customer;

    if (!customer) {
      return new Response(JSON.stringify({ error: "Customer not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!claimResult.claimed) {
      if (customer.square_customer_id) {
        return new Response(
          JSON.stringify({
            success: true,
            square_customer_id: customer.square_customer_id,
            already_linked: true,
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      return new Response(
        JSON.stringify({ success: true, processing: true }),
        {
          status: 202,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    activeClaim = { customerId: customer.id, claimToken };

    // Choose correct Square API URL based on environment
    const squareBaseUrl =
      SQUARE_ENVIRONMENT === "production"
        ? "https://connect.squareup.com"
        : "https://connect.squareupsandbox.com";

    // Recover a customer created by an earlier attempt whose Supabase
    // write-back failed. Search is reconciliation only; the database claim
    // and stable idempotency key are what protect the concurrent path.
    const existingSquareCustomers: Array<{ id: string; reference_id?: string }> = [];
    let searchCursor: string | undefined;

    if (customer.dressup_member_id) {
      do {
        const searchResponse = await fetch(
          `${squareBaseUrl}/v2/customers/search`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Square-Version": "2024-01-18",
              Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
            },
            body: JSON.stringify({
              query: {
                filter: {
                  reference_id: { exact: customer.dressup_member_id },
                },
              },
              limit: 100,
              ...(searchCursor ? { cursor: searchCursor } : {}),
            }),
          }
        );
        const searchResult = await searchResponse.json();

        if (!searchResponse.ok) {
          await supabaseAdmin.rpc("release_square_customer_sync", {
            p_customer_id: customer.id,
            p_claim_token: claimToken,
          });
          activeClaim = null;

          return new Response(
            JSON.stringify({
              error: "Could not search Square for an existing customer",
              details: searchResult,
            }),
            {
              status: 502,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            }
          );
        }

        existingSquareCustomers.push(
          ...(searchResult.customers || []).filter(
            (squareCustomer: { reference_id?: string }) =>
              squareCustomer.reference_id === customer.dressup_member_id
          )
        );
        searchCursor = searchResult.cursor || undefined;
      } while (searchCursor);
    }

    if (existingSquareCustomers.length > 1) {
      await supabaseAdmin.rpc("release_square_customer_sync", {
        p_customer_id: customer.id,
        p_claim_token: claimToken,
      });
      activeClaim = null;

      return new Response(
        JSON.stringify({
          error: "Multiple Square customers already use this member reference",
          square_customer_ids: existingSquareCustomers.map((item) => item.id),
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (existingSquareCustomers.length === 1) {
      const existingSquareCustomerId = existingSquareCustomers[0].id;
      const { data: completion, error: completionError } = await supabaseAdmin.rpc(
        "complete_square_customer_sync",
        {
          p_customer_id: customer.id,
          p_claim_token: claimToken,
          p_square_customer_id: existingSquareCustomerId,
        }
      );

      if (completionError || !completion?.completed) {
        return new Response(
          JSON.stringify({
            error: completionError?.message || "Could not link the existing Square customer",
            existing_square_customer_id: completion?.square_customer_id || null,
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      activeClaim = null;

      return new Response(
        JSON.stringify({
          success: true,
          square_customer_id: existingSquareCustomerId,
          reconciled_existing: true,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Convert "DD/MM" birthday to Square format (YYYY-MM-DD).
    // Square requires customers to be at least 13 years old, so we use the
    // fixed year 2000 when no year was collected from the customer.
    const squareBirthday = (() => {
      if (!customer.birthday) return undefined;
      const match = customer.birthday.match(/^(\d{2})\/(\d{2})$/);
      if (!match) return undefined;
      return `2000-${match[2]}-${match[1]}`;
    })();

    // 1. Prepare Customer Data for Square API
    const squareCustomerData = {
      // The row UUID is stable across deliveries of the same registration.
      // Reuse it only for retries of this same create operation and payload.
      idempotency_key: customer.id,
      given_name: customer.first_name,
      family_name: customer.last_name || "",
      phone_number: customer.phone || "",
      email_address: customer.email || undefined,
      reference_id: customer.dressup_member_id,
      note: `DressupHT Loyalty Member ID: ${customer.dressup_member_id}`,
      ...(squareBirthday ? { birthday: squareBirthday } : {}),
    };

    // 2. Call Square API to create/sync customer
    const squareResponse = await fetch(
      `${squareBaseUrl}/v2/customers`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Square-Version": "2024-01-18",
          Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
        },
        body: JSON.stringify(squareCustomerData),
      }
    );

    const squareResult = await squareResponse.json();

    if (!squareResponse.ok) {
      console.error("Square API Error:", squareResult);

      await supabaseAdmin.rpc("release_square_customer_sync", {
        p_customer_id: customer.id,
        p_claim_token: claimToken,
      });
      activeClaim = null;

      return new Response(
        JSON.stringify({
          error: "Failed to sync with Square",
          details: squareResult,
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    // Extract Square's customer ID from the response
    const squareCustomerId = squareResult.customer?.id;

    if (!squareCustomerId) {
      await supabaseAdmin.rpc("release_square_customer_sync", {
        p_customer_id: customer.id,
        p_claim_token: claimToken,
      });
      activeClaim = null;

      return new Response(
        JSON.stringify({ error: "Square response did not include a customer ID" }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { data: completion, error: completionError } = await supabaseAdmin.rpc(
      "complete_square_customer_sync",
      {
        p_customer_id: customer.id,
        p_claim_token: claimToken,
        p_square_customer_id: squareCustomerId,
      }
    );

    if (completionError || !completion?.completed) {
      if (completion?.square_customer_id && completion.square_customer_id !== squareCustomerId) {
        console.error(
          "Square customer conflict; preserving the existing Supabase link:",
          completion.square_customer_id,
          squareCustomerId
        );
      } else {
        console.error("Failed to save Square customer link:", completionError);
      }

      return new Response(
        JSON.stringify({
          error: completionError?.message || "Square customer link was not saved",
          square_customer_id: squareCustomerId,
          existing_square_customer_id: completion?.square_customer_id || null,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    activeClaim = null;

    return new Response(
      JSON.stringify({
        success: true,
        square_customer_id: squareCustomerId,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("Edge function error:", err);

    if (activeClaim) {
      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

      if (supabaseUrl && serviceRoleKey) {
        const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);
        const { error: releaseError } = await supabaseAdmin.rpc(
          "release_square_customer_sync",
          {
            p_customer_id: activeClaim.customerId,
            p_claim_token: activeClaim.claimToken,
          }
        );

        if (releaseError) {
          console.error("Could not release Square sync claim:", releaseError);
        }
      }
    }

    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});
