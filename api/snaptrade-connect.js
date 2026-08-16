// api/snaptrade-connect.js — hands the user a one-time SnapTrade portal URL.
// The user logs in at their broker; credentials never touch our servers.

import { Snaptrade } from "snaptrade-typescript-sdk";

const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_4rtnWGGUaEnX4NTF8-iBiA_D8vJAAa4";

const snaptrade = new Snaptrade({
  clientId: process.env.SNAPTRADE_CLIENT_ID,
  consumerKey: process.env.SNAPTRADE_CONSUMER_KEY,
});

const sbHeaders = () => ({
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
});

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    // Who is asking?
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Not signed in" });

    const uRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!uRes.ok) return res.status(401).json({ error: "Session expired — sign in again" });
    const user = await uRes.json();

    // Load their profile.
    const pRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=plan,plan_status,snaptrade_user_id,snaptrade_user_secret`,
      { headers: sbHeaders() }
    );
    const [profile] = await pRes.json();

    // Every connected user costs us money each month, so this is Pro only.
    const isPro = profile?.plan === "pro" && ["active", "trialing"].includes(profile?.plan_status);
    if (!isPro) {
      return res.status(402).json({ error: "Connecting a brokerage is part of Pro." });
    }

    // Register with SnapTrade on first use. The user secret is generated once
    // and can never be retrieved again, so it must be stored on first receipt.
    let snapUserId = profile?.snaptrade_user_id;
    let snapUserSecret = profile?.snaptrade_user_secret;

    if (!snapUserId || !snapUserSecret) {
      snapUserId = `dripbook_${user.id}`;
      const reg = await snaptrade.authentication.registerSnapTradeUser({ userId: snapUserId });
      snapUserSecret = reg.data.userSecret;

      const save = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
        method: "PATCH",
        headers: sbHeaders(),
        body: JSON.stringify({
          snaptrade_user_id: snapUserId,
          snaptrade_user_secret: snapUserSecret,
        }),
      });
      if (!save.ok) {
        const t = await save.text();
        throw new Error(`Could not store the SnapTrade secret: ${t.slice(0, 200)}`);
      }
    }

    // Generate the portal link.
    const origin = req.headers.origin || `https://${req.headers.host}`;
    const { broker } = req.body || {};

    const login = await snaptrade.authentication.loginSnapTradeUser({
      userId: snapUserId,
      userSecret: snapUserSecret,
      connectionType: "read", // read-only. No trading, ever.
      immediateRedirect: true,
      customRedirect: `${origin}/?connected=1`,
      ...(broker ? { broker } : {}),
    });

    const url = login.data?.redirectURI;
    if (!url) throw new Error("SnapTrade did not return a portal URL");

    return res.status(200).json({ url });
  } catch (err) {
    console.error("snaptrade-connect error:", err?.responseBody || err.message);
    return res.status(500).json({ error: err?.responseBody?.detail || err.message });
  }
}
