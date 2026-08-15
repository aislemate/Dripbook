// api/checkout.js — creates a Stripe Checkout session for the signed-in user.

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    // 1. Who is asking? Verify the Supabase token — never trust a user id sent by the browser.
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Not signed in" });

    const uRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!uRes.ok) return res.status(401).json({ error: "Session expired — sign in again" });
    const user = await uRes.json();

    // 2. Which plan?
    const { plan } = req.body || {};
    const price = plan === "yearly" ? process.env.STRIPE_PRICE_YEARLY : process.env.STRIPE_PRICE_MONTHLY;
    if (!price) return res.status(500).json({ error: "Price is not configured" });

    // 3. Reuse this user's Stripe customer if they have one, so billing history stays together.
    const pRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=stripe_customer_id`,
      { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    const [profile] = await pRes.json();

    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_uid: user.id },
      });
      customerId = customer.id;
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
        method: "PATCH",
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ stripe_customer_id: customerId }),
      });
    }

    // 4. Build the checkout session.
    const origin = req.headers.origin || `https://${req.headers.host}`;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price, quantity: 1 }],
      subscription_data: {
        trial_period_days: 7,
        metadata: { supabase_uid: user.id },
      },
      metadata: { supabase_uid: user.id },
      allow_promotion_codes: true,
      success_url: `${origin}/?upgraded=1`,
      cancel_url: `${origin}/?canceled=1`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("checkout error:", err);
    return res.status(500).json({ error: err.message });
  }
}
