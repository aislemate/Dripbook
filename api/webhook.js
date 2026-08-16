// api/webhook.js — Stripe tells us what happened; we update the database.
// This is the ONLY thing that grants Pro. The browser can never set it.
//
// Uses the Web handler signature (Request in, Response out). Vercel parses
// the body on the older Node signature, which breaks Stripe's signature
// check. request.text() here gives the untouched raw payload.

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function setPlan(uid, fields) {
  if (!uid) {
    console.error("no supabase uid — skipping update");
    return;
  }
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${uid}`, {
    method: "PATCH",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(fields),
  });
  const text = await res.text();
  console.log("supabase update", res.status, text.slice(0, 300));
  if (!res.ok) throw new Error(`Supabase write failed: ${res.status} ${text.slice(0, 200)}`);
}

// Find the Supabase user behind a Stripe customer, however we can.
async function uidFor(sub) {
  if (sub.metadata?.supabase_uid) return sub.metadata.supabase_uid;

  try {
    const customer = await stripe.customers.retrieve(sub.customer);
    if (customer?.metadata?.supabase_uid) return customer.metadata.supabase_uid;
  } catch (e) {
    console.error("customer lookup failed:", e.message);
  }

  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/profiles?stripe_customer_id=eq.${sub.customer}&select=id`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  const rows = await res.json();
  return rows?.[0]?.id;
}

export default async function handler(request) {
  const signature = request.headers.get("stripe-signature");
  const raw = await request.text();

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      raw,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    // A bad signature means this did not come from Stripe. Reject it.
    console.error("signature check failed:", err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  console.log("received event:", event.type);

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const uid = await uidFor(sub);
        const live = ["active", "trialing", "past_due"].includes(sub.status);
        await setPlan(uid, {
          plan: live ? "pro" : "free",
          plan_status: sub.status === "unpaid" ? "canceled" : sub.status,
          stripe_subscription_id: sub.id,
          current_period_end: sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : null,
        });
        break;
      }

      case "checkout.session.completed": {
        // Belt and braces: usually the subscription event lands first, but if
        // it is delayed the buyer still gets access straight away.
        const s = event.data.object;
        if (s.subscription) {
          const sub = await stripe.subscriptions.retrieve(s.subscription);
          const uid = s.metadata?.supabase_uid || (await uidFor(sub));
          await setPlan(uid, {
            plan: "pro",
            plan_status: sub.status,
            stripe_subscription_id: sub.id,
            stripe_customer_id: s.customer,
            current_period_end: sub.current_period_end
              ? new Date(sub.current_period_end * 1000).toISOString()
              : null,
          });
        }
        break;
      }
    }
  } catch (err) {
    console.error("handler error:", err.message);
    return new Response(`Handler failed: ${err.message}`, { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
