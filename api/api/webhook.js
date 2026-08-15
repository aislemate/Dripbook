// api/webhook.js — Stripe tells us what happened; we update the database.
// This is the ONLY thing that grants Pro. The browser can never set it.

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Signature checking needs the raw body, so turn off automatic parsing.
export const config = { api: { bodyParser: false } };

function rawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function setPlan(uid, fields) {
  if (!uid) return;
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${uid}`, {
    method: "PATCH",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(fields),
  });
}

// Find the Supabase user behind a Stripe customer, even if metadata is missing.
async function uidFor(sub) {
  if (sub.metadata?.supabase_uid) return sub.metadata.supabase_uid;
  const customer = await stripe.customers.retrieve(sub.customer);
  if (customer?.metadata?.supabase_uid) return customer.metadata.supabase_uid;
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/profiles?stripe_customer_id=eq.${sub.customer}&select=id`,
    { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const [row] = await res.json();
  return row?.id;
}

export default async function handler(req, res) {
  let event;
  try {
    const body = await rawBody(req);
    event = stripe.webhooks.constructEvent(
      body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    // A bad signature means this did not come from Stripe. Reject it.
    console.error("bad signature:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

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
          current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
        });
        break;
      }

      case "checkout.session.completed": {
        // Belt and braces: the subscription events above usually land first,
        // but if they are delayed the user still gets access immediately.
        const s = event.data.object;
        if (s.subscription) {
          const sub = await stripe.subscriptions.retrieve(s.subscription);
          await setPlan(s.metadata?.supabase_uid || (await uidFor(sub)), {
            plan: "pro",
            plan_status: sub.status,
            stripe_subscription_id: sub.id,
            stripe_customer_id: s.customer,
            current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
          });
        }
        break;
      }
    }
  } catch (err) {
    console.error("handler error:", err);
    return res.status(500).send("Handler failed");
  }

  return res.status(200).json({ received: true });
}
