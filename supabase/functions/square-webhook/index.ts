import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SQUARE_VERSION = "2026-09-16";

function getSquareBaseUrl() {
  const environment = Deno.env.get("SQUARE_ENVIRONMENT") || "production";

  return environment === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

// ---------------------------------------------------------
// SQUARE WEBHOOK SIGNATURE VERIFICATION
// ---------------------------------------------------------
// Square signs every notification with HMAC-SHA256 over
//
//   notification_url + raw_request_body
//
// using the signature key of the webhook subscription, and sends the digest in
// the x-square-hmacsha256-signature header. Both the notification URL and the
// signature key are read from environment secrets; neither is written in this
// file and neither has a default, so a misconfigured deployment fails closed
// instead of silently accepting unsigned requests.
//
// The raw body is verified before it is parsed. Re-serializing parsed JSON
// would change the bytes Square signed, so the exact text is used as received.

const SQUARE_SIGNATURE_HEADER = "x-square-hmacsha256-signature";

type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: string };

// Square sends the digest base64 encoded.
function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

async function verifySquareSignature(
  rawBody: string,
  providedSignature: string | null
): Promise<SignatureCheck> {
  if (!providedSignature) {
    return { ok: false, reason: "signature_missing" };
  }

  const notificationUrl = Deno.env.get("SQUARE_WEBHOOK_NOTIFICATION_URL");
  const signatureKey = Deno.env.get("SQUARE_WEBHOOK_SIGNATURE_KEY");

  if (!notificationUrl || !signatureKey) {
    return { ok: false, reason: "configuration_missing" };
  }

  let providedBytes: Uint8Array;

  try {
    providedBytes = base64ToBytes(providedSignature);
  } catch {
    return { ok: false, reason: "signature_malformed" };
  }

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signatureKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    // crypto.subtle.verify recomputes the digest and compares the two MACs in
    // constant time, which is why no hand written comparison is used here.
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      providedBytes,
      new TextEncoder().encode(notificationUrl + rawBody)
    );

    return valid ? { ok: true } : { ok: false, reason: "signature_mismatch" };
  } catch {
    return { ok: false, reason: "signature_malformed" };
  }
}

// Deliberately opaque: the caller only learns that the request was refused, and
// nothing about the signature, the key, or the expected URL.
function signatureRejected(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    headers: { "Content-Type": "application/json" },
    status: 403,
  });
}

type LoyaltyAwardEntry = {
  entry_type: string;
  points: number;
  transaction_id?: string;
};

type LoyaltyAwardResult = {
  status?: string;
  reason?: string;
  square_order_id?: string;
  total_usd?: number;
  eligible_usd?: number;
  cashback_points?: number;
  birthday_points?: number;
  referral_points?: number;
  points_balance?: number;
  awarded?: LoyaltyAwardEntry[];
  skipped?: Array<{ entry_type: string; reason: string }>;
};

// Awards DressupHT loyalty points for a purchase that has just been stored.
//
// The loyalty engine (public.award_dressupht_loyalty_for_purchase) is the only
// place points are calculated. It reads the stored purchase row itself - the
// customer, the Square order id, the order total, the currency and the line
// items - so no part of the rules is duplicated here: this file contains no
// exchange rate, no cashback rate, no threshold and no bonus amount, and it
// never touches Square Loyalty.
//
// The Square order id remains the reference key, because the engine derives its
// idempotency key from it. A redelivered webhook therefore returns
// "no_new_awards" instead of crediting the order a second time.
//
// Failures are swallowed on purpose. The purchase is already persisted at this
// point, and a loyalty problem must not make this webhook fail, because Square
// would then redeliver the event and keep retrying.
async function awardDressuphtLoyalty(
  supabaseAdmin: ReturnType<typeof createClient>,
  purchaseId: string | null,
  squareOrderId: string
): Promise<void> {
  if (!purchaseId) {
    console.warn(
      "Loyalty award skipped: purchase row id unavailable",
      JSON.stringify({ square_order_id: squareOrderId, reason: "purchase_id_missing" })
    );
    return;
  }

  console.log(
    "Loyalty award attempted",
    JSON.stringify({ square_order_id: squareOrderId, purchase_id: purchaseId })
  );

  try {
    const { data, error } = await supabaseAdmin.rpc(
      "award_dressupht_loyalty_for_purchase",
      { p_purchase_id: purchaseId }
    );

    if (error) {
      console.error(
        "Loyalty award error",
        JSON.stringify({
          square_order_id: squareOrderId,
          purchase_id: purchaseId,
          message: error.message,
        })
      );
      return;
    }

    const result = (data ?? {}) as LoyaltyAwardResult;

    const summary = {
      square_order_id: squareOrderId,
      status: result.status ?? "unknown",
      eligible_usd: result.eligible_usd ?? null,
      cashback_points: result.cashback_points ?? 0,
      birthday_points: result.birthday_points ?? 0,
      referral_points: result.referral_points ?? 0,
      points_balance: result.points_balance ?? null,
    };

    if (result.status === "awarded") {
      console.log(
        "Loyalty award applied",
        JSON.stringify({ ...summary, awarded: result.awarded ?? [] })
      );
      return;
    }

    if (result.status === "no_new_awards") {
      console.log(
        "Loyalty award already processed (idempotent, nothing awarded again)",
        JSON.stringify({ ...summary, skipped: result.skipped ?? [] })
      );
      return;
    }

    console.log(
      "Loyalty award skipped",
      JSON.stringify({ ...summary, reason: result.reason ?? "unknown" })
    );
  } catch (err) {
    console.error(
      "Loyalty award error",
      JSON.stringify({
        square_order_id: squareOrderId,
        purchase_id: purchaseId,
        message: err instanceof Error ? err.message : String(err),
      })
    );
  }
}


serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Authenticate before anything else. The body is read once, as text, and the
  // signature is checked against those exact bytes before the JSON is parsed,
  // before Supabase is contacted, and before the loyalty engine is reached.
  let rawBody: string;

  try {
    rawBody = await req.text();
  } catch {
    console.error(
      "Square webhook signature verification failed",
      JSON.stringify({ reason: "body_unreadable" })
    );
    return signatureRejected();
  }

  const providedSignature = req.headers.get(SQUARE_SIGNATURE_HEADER);
  const signatureCheck = await verifySquareSignature(rawBody, providedSignature);

  if (!signatureCheck.ok) {
    console.error(
      "Square webhook signature verification failed",
      JSON.stringify({ reason: signatureCheck.reason })
    );
    return signatureRejected();
  }

  console.log("Square webhook signature verified");

  try {
    const payload = JSON.parse(rawBody);
    const eventType = payload.type;

    // ---------------------------------------------------------
    // PURCHASE EVENTS ONLY
    // ---------------------------------------------------------
    // This webhook turns Square orders into DressupHT loyalty and nothing else.
    // The notification has already been authenticated above, so any event type
    // that is not a purchase event is acknowledged here: it writes nothing,
    // never reaches the loyalty engine, and Square receives a 200 so it stops
    // redelivering.
    //
    // The request is authenticated at this point and the event type is known,
    // so the check happens here, before any client is created and before any
    // configuration is read: an event that is not processed cannot fail
    // because of a secret it would never have used.
    const PURCHASE_EVENT_TYPES = ["order.created", "order.updated"];

    if (!PURCHASE_EVENT_TYPES.includes(eventType)) {
      console.log(
        "Square webhook event acknowledged without processing",
        JSON.stringify({ event_type: eventType ?? null })
      );

      return new Response(
        JSON.stringify({ message: "Event ignored" }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }
      );
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const SQUARE_ACCESS_TOKEN = Deno.env.get("SQUARE_ACCESS_TOKEN");

    if (!SQUARE_ACCESS_TOKEN) {
      throw new Error("SQUARE_ACCESS_TOKEN is not configured");
    }

    const squareBaseUrl = getSquareBaseUrl();

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
    // The stored row id is requested as well: the loyalty engine is keyed on
    // it, and reading it back here avoids a second lookup by order id.
    const { data: savedPurchase, error: insertError } =
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
        )
        .select("id")
        .single();

    if (insertError) {
      console.error(
        "Error inserting purchase:",
        insertError
      );

      throw new Error(insertError.message);
    }

    // ---------------------------------------------------------
    // LOYALTY (DressupHT engine, never Square Loyalty)
    // ---------------------------------------------------------
    // Runs only after the purchase is safely stored, and never throws: the
    // response below must stay the one Square already expects.
    await awardDressuphtLoyalty(
      supabaseAdmin,
      savedPurchase?.id ?? null,
      squareOrderId
    );

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
