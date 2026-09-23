import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const payload = await req.json();
    
    // Check if the webhook event is related to a completed order
    const eventType = payload.type;
    if (eventType !== "order.updated" && eventType !== "order.created") {
      return new Response(JSON.stringify({ message: "Event ignored" }), { status: 200 });
    }

    const orderData = payload.data?.object?.order_updated || payload.data?.object?.order;
    if (!orderData) {
      return new Response(JSON.stringify({ message: "No order data found" }), { status: 200 });
    }

    // Only process completed orders
    if (orderData.state !== "COMPLETED") {
      return new Response(JSON.stringify({ message: "Order not completed yet" }), { status: 200 });
    }

    const squareOrderId = orderData.id;
    const squareCustomerId = orderData.customer_id;
    const totalAmount = orderData.total_money?.amount ? orderData.total_money.amount / 100 : 0; // Convert cents to currency
    const currency = orderData.total_money?.currency || "HTG";
    const lineItems = orderData.line_items || [];

    if (!squareCustomerId) {
      return new Response(JSON.stringify({ message: "Order has no associated customer" }), { status: 200 });
    }

    // Initialize Supabase Admin Client
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // 1. Find the customer in Supabase using their square_customer_id
    const { data: customer, error: custError } = await supabaseAdmin
      .from("customers")
      .select("id")
      .eq("square_customer_id", squareCustomerId)
      .single();

    if (custError || !customer) {
      console.error("Customer not found in Supabase for Square ID:", squareCustomerId);
      return new Response(JSON.stringify({ message: "Customer mapping not found" }), { status: 404 });
    }

    // 2. Insert the purchase record
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