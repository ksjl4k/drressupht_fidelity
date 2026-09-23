import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SQUARE_VERSION = "2026-09-16";

function getSquareBaseUrl() {
  const environment = Deno.env.get("SQUARE_ENVIRONMENT") || "production";

  return environment === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

function generateDressupMemberId(firstName: string): string {
  const cleanFirstName = firstName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");

  const randomNumber = Math.floor(100000 + Math.random() * 900000);

  return `${cleanFirstName}-${randomNumber}`;
}

// Helper function to convert Square birthday (YYYY-MM-DD) to JJ/MM format (DD/MM)
function formatBirthdayToJJMM(squareBirthday: string | null | undefined): string | null {
  if (!squareBirthday) return null;

  try {
    const parts = squareBirthday.split(/[-/]/);
    if (parts.length >= 3) {
      // YYYY-MM-DD -> parts[1] is MM, parts[2] is DD (JJ)
      const month = parts[1];
      const day = parts[2];
      return `${day}/${month}`;
    } else if (parts.length === 2) {
      // MM-DD -> DD/MM
      return `${parts[1]}/${parts[0]}`;
    }
  } catch (e) {
    console.error("Error parsing birthday:", e);
  }

  return null;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const payload = await req.json();
    const eventType = payload.type;

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const SQUARE_ACCESS_TOKEN = Deno.env.get("SQUARE_ACCESS_TOKEN");

    if (!SQUARE_ACCESS_TOKEN) {
      throw new Error("SQUARE_ACCESS_TOKEN is not configured");
    }

    const squareBaseUrl = getSquareBaseUrl();

    // ---------------------------------------------------------
    // CUSTOMER CREATED
    // ---------------------------------------------------------

    if (eventType === "customer.created") {
      // Match the exact nesting structure from Square's webhook payload
      const squareCustomer = payload.data?.object?.customer;

      if (!squareCustomer) {
        return new Response(
          JSON.stringify({ message: "No customer found in webhook" }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }
        );
      }

      const squareCustomerId = squareCustomer.id;

      if (!squareCustomerId) {
        return new Response(
          JSON.stringify({ message: "No Square customer ID found" }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }
        );
      }

      // Check whether this Square customer already exists.
      const { data: existingCustomer, error: existingError } =
        await supabaseAdmin
          .from("customers")
          .select("id, dressup_member_id")
          .eq("square_customer_id", squareCustomerId)
          .maybeSingle();

      if (existingError) {
        throw new Error(
          `Error checking existing customer: ${existingError.message}`
        );
      }

      // Reuse the existing DressupHT ID if this webhook is retried.
      const dressupMemberId =
        existingCustomer?.dressup_member_id ||
        squareCustomer.reference_id ||
        generateDressupMemberId(squareCustomer.given_name || "customer");

      // Convert birthday from YYYY-MM-DD to JJ/MM
      const formattedBirthday = formatBirthdayToJJMM(squareCustomer.birthday);

      // Save the customer in Supabase.
      const { error: customerError } = await supabaseAdmin
        .from("customers")
        .upsert(
          {
            dressup_member_id: dressupMemberId,
            first_name: squareCustomer.given_name || "Unknown",
            last_name: squareCustomer.family_name || "Unknown",
            email: squareCustomer.email_address || null,
            phone: squareCustomer.phone_number || "UNKNOWN",
            birthday: formattedBirthday,
            square_customer_id: squareCustomerId,
          },
          {
            onConflict: "square_customer_id",
          }
        );

      if (customerError) {
        throw new Error(
          `Error saving customer to Supabase: ${customerError.message}`
        );
      }

      // If Square did not already have a DressupHT reference ID,
      // write the generated DressupHT member ID back to Square.
      if (squareCustomer.reference_id !== dressupMemberId) {
        const updateResponse = await fetch(
          `${squareBaseUrl}/v2/customers/${squareCustomerId}`,
          {
            method: "PUT",
            headers: {
              "Square-Version": SQUARE_VERSION,
              "Authorization": `Bearer ${SQUARE_ACCESS_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              reference_id: dressupMemberId,
              note: `DressupHT Member ID: ${dressupMemberId}`,
              version: squareCustomer.version,
            }),
          }
        );

        const updateResult = await updateResponse.json();

        if (!updateResponse.ok) {
          console.error(
            "Failed to update Square customer:",
            updateResult
          );

          throw new Error(
            `Square customer update failed: ${JSON.stringify(updateResult)}`
          );
        }
      }

      console.log(
        `Customer synced: Square ${squareCustomerId} → ${dressupMemberId} with birthday: ${formattedBirthday}`
      );

      return new Response(
        JSON.stringify({
          success: true,
          message: "Customer synced successfully",
          square_customer_id: squareCustomerId,
          dressup_member_id: dressupMemberId,
          birthday: formattedBirthday,
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }
      );
    }

    // ---------------------------------------------------------
    // ORDER CREATED / UPDATED
    // ---------------------------------------------------------

    if (
      eventType !== "order.updated" &&
      eventType !== "order.created"
    ) {
      return new Response(
        JSON.stringify({ message: "Event ignored" }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }
      );
    }

    const squareOrderId =
      payload.data?.object?.order_updated?.order_id ||
      payload.data?.object?.order?.id;

    if (!squareOrderId) {
      return new Response(
        JSON.stringify({ message: "No order ID found in webhook" }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }
      );
    }

    // Fetch the complete order from Square.
    const orderResponse = await fetch(
      `${squareBaseUrl}/v2/orders/${squareOrderId}`,
      {
        method: "GET",
        headers: {
          "Square-Version": SQUARE_VERSION,
          "Authorization": `Bearer ${SQUARE_ACCESS_TOKEN}`,
        },
      }
    );

    const orderResult = await orderResponse.json();
    const orderData = orderResult.order;

    if (!orderData || orderData.state !== "COMPLETED") {
      return new Response(
        JSON.stringify({
          message: "Order not completed or not found",
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }
      );
    }

    const squareCustomerId = orderData.customer_id;

    const totalAmount = orderData.total_money?.amount
      ? orderData.total_money.amount / 100
      : 0;

    const currency =
      orderData.total_money?.currency || "HTG";

    const lineItems = orderData.line_items || [];

    if (!squareCustomerId) {
      console.log(
        "Order completed without an attached loyalty customer ID:",
        squareOrderId
      );

      return new Response(
        JSON.stringify({
          message: "Order has no associated customer",
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }
      );
    }

    // Find the customer in Supabase.
    const { data: customer, error: custError } =
      await supabaseAdmin
        .from("customers")
        .select("id")
        .eq("square_customer_id", squareCustomerId)
        .single();

    if (custError || !customer) {
      console.error(
        "Customer mapping not found for Square Customer ID:",
        squareCustomerId
      );

      return new Response(
        JSON.stringify({
          message: "Customer mapping not found in database",
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 404,
        }
      );
    }

    // Insert/update purchase record.
    const { error: insertError } =
      await supabaseAdmin
        .from("purchases")
        .upsert(
          {
            customer_id: customer.id,
            square_order_id: squareOrderId,
            total_amount: totalAmount,
            currency: currency,
            items: lineItems,
          },
          {
            onConflict: "square_order_id",
          }
        );

    if (insertError) {
      console.error(
        "Error inserting purchase:",
        insertError
      );

      throw new Error(insertError.message);
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Purchase recorded successfully",
      }),
      {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }
    );
  } catch (err) {
    console.error("Webhook error:", err);

    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }),
      {
        headers: { "Content-Type": "application/json" },
        status: 500,
      }
    );
  }
});