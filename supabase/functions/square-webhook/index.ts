import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const payload = await req.json();
    
    const eventType = payload.type;
    if (eventType !== "order.updated" && eventType !== "order.created") {
      return new Response(JSON.stringify({ message: "Event ignored" }), { status: 200 });
    }

    // Extract the order ID from the webhook event
    const squareOrderId =
        payload.data?.object?.order_updated?.order_id ||
        payload.data?.object?.order?.id;

    if (!squareOrderId) {
      return new Response(JSON.stringify({ message: "No order ID found in webhook" }), { status: 200 });
    }

    const SQUARE_ACCESS_TOKEN = Deno.env.get("SQUARE_ACCESS_TOKEN");
    const SQUARE_ENVIRONMENT = Deno.env.get("SQUARE_ENVIRONMENT") || "production";
    const squareBaseUrl = SQUARE_ENVIRONMENT === "production" 
      ? "https://connect.squareup.com" 
      : "https://connect.squareupsandbox.com";

    // FETCH FULL ORDER DETAILS DIRECTLY FROM SQUARE API
    const orderResponse = await fetch(`${squareBaseUrl}/v2/orders/${squareOrderId}`, {
      method: "GET",
      headers: {
        "Square-Version": "2024-01-18",
        "Authorization": `Bearer ${SQUARE_ACCESS_TOKEN}`
      }
    });

    const orderResult = await orderResponse.json();
    const orderData = orderResult.order;

    if (!orderData || orderData.state !== "COMPLETED") {
      return new Response(JSON.stringify({ message: "Order not completed or not found" }), { status: 200 });
    }

    const squareCustomerId = orderData.customer_id;
    const totalAmount = orderData.total_money?.amount ? orderData.total_money.amount / 100 : 0;
    const currency = orderData.total_money?.currency || "HTG";
    const lineItems = orderData.line_items || [];

    if (!squareCustomerId) {
      console.log("Order completed without an attached loyalty customer ID:", squareOrderId);
      return new Response(JSON.stringify({ message: "Order has no associated customer" }), { status: 200 });
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Find the customer in Supabase
    const { data: customer, error: custError } = await supabaseAdmin
      .from("customers")
      .select("id")
      .eq("square_customer_id", squareCustomerId)
      .single();

    if (custError || !customer) {
      console.error("Customer mapping not found for Square Customer ID:", squareCustomerId);
      return new Response(JSON.stringify({ message: "Customer mapping not found in database" }), { status: 404 });
    }

    // Insert purchase record
    const { error: insertError } = await supabaseAdmin
      .from("purchases")
      .upsert({
        customer_id: customer.id,
        square_order_id: squareOrderId,
        total_amount: totalAmount,
        currency: currency,
        items: lineItems
      }, { onConflict: "square_order_id" });

    if (insertError) {
      console.error("Error inserting purchase:", insertError);
      return new Response(JSON.stringify({ error: insertError.message }), { status: 500 });
    }

    return new Response(JSON.stringify({ success: true, message: "Purchase recorded successfully" }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });

  } catch (err) {
    console.error("Webhook error:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});