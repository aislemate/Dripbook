// api/portal.js — sends a subscriber to Stripe's billing portal to
// update their card, see invoices, or cancel. Cancelling has to be easy.

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Public by design — this key is already visible in the browser.
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_4rtnWGGUaEnX4NTF8-iBiA_D8vJAAa4";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "No token reached the server. Sign out and back in." });

    if (!process.env.SUPABASE_URL) return res.status(500).json({ error: "SUPABASE_URL is not set in Vercel" });
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY is not set in Vercel" });

    // Identify the caller with the PUBLISHABLE key — the user's own bearer token
    // is what proves who they are. The service key is only needed for writes below.
    const uRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!uRes.ok) {
      const detail = await uRes.text();
      return res.status(401).json({ error: `Supabase rejected the session (${uRes.status}): ${detail.slice(0, 200)}` });
    }
    const user = await uRes.json();

    const pRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=stripe_customer_id`,
      { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    const [profile] = await pRes.json();
    if (!profile?.stripe_customer_id) return res.status(400).json({ error: "No billing account yet" });

    const origin = req.headers.origin || `https://${req.headers.host}`;
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: origin,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("portal error:", err);
    return res.status(500).json({ error: err.message });
  }
}
