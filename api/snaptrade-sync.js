// api/snaptrade-sync.js — pulls positions from every connected brokerage
// account and writes them into holdings.
//
// Deliberately conservative: it updates shares, price and cost basis, but
// never overwrites dividend figures or payment schedules the user has set.
// The brokerage knows what you own; it does not know when KO pays.

import { Snaptrade } from "snaptrade-typescript-sdk";

const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_4rtnWGGUaEnX4NTF8-iBiA_D8vJAAa4";

const snaptrade = new Snaptrade({
  clientId: process.env.SNAPTRADE_CLIENT_ID,
  consumerKey: process.env.SNAPTRADE_CONSUMER_KEY,
});

const sbHeaders = (extra = {}) => ({
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
  ...extra,
});

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// SnapTrade shapes vary a little by brokerage, so read defensively.
function readPosition(p) {
  const sym = p.symbol?.symbol || p.symbol || {};
  const ticker = (sym.symbol || sym.raw_symbol || "").toString().toUpperCase().trim();
  if (!ticker) return null;

  return {
    ticker: ticker.slice(0, 12),
    name: (sym.description || sym.name || "").toString().slice(0, 120),
    shares: num(p.units ?? p.quantity ?? p.fractional_units),
    price: num(p.price ?? sym.last_price ?? 0),
    cost: num(p.average_purchase_price ?? p.price ?? 0),
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Not signed in" });

    const uRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!uRes.ok) return res.status(401).json({ error: "Session expired — sign in again" });
    const user = await uRes.json();

    const pRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=plan,plan_status,snaptrade_user_id,snaptrade_user_secret`,
      { headers: sbHeaders() }
    );
    const [profile] = await pRes.json();

    const isPro = profile?.plan === "pro" && ["active", "trialing"].includes(profile?.plan_status);
    if (!isPro) return res.status(402).json({ error: "Brokerage sync is part of Pro." });
    if (!profile?.snaptrade_user_id || !profile?.snaptrade_user_secret) {
      return res.status(400).json({ error: "No brokerage connected yet." });
    }

    const creds = {
      userId: profile.snaptrade_user_id,
      userSecret: profile.snaptrade_user_secret,
    };

    // 1. Which accounts did they link?
    const accountsRes = await snaptrade.accountInformation.listUserAccounts(creds);
    const accounts = accountsRes.data || [];
    if (!accounts.length) {
      return res.status(200).json({ imported: 0, updated: 0, accounts: 0, message: "No accounts linked yet." });
    }

    // 2. Pull positions from each.
    const found = new Map();
    let brokerName = null;

    for (const acct of accounts) {
      brokerName = brokerName || acct.institution_name || acct.brokerage?.name || null;
      let positions = [];
      try {
        const h = await snaptrade.accountInformation.getUserHoldings({
          ...creds,
          accountId: acct.id,
        });
        positions = h.data?.positions || h.data?.position || [];
      } catch (e) {
        console.error(`positions failed for account ${acct.id}:`, e?.responseBody || e.message);
        continue;
      }

      for (const raw of positions) {
        const pos = readPosition(raw);
        if (!pos || pos.shares <= 0) continue;
        // Same ticket held in two accounts: combine, weighting cost by shares.
        const prev = found.get(pos.ticker);
        if (prev) {
          const total = prev.shares + pos.shares;
          prev.cost = total ? (prev.cost * prev.shares + pos.cost * pos.shares) / total : prev.cost;
          prev.shares = total;
          prev.price = pos.price || prev.price;
        } else {
          found.set(pos.ticker, pos);
        }
      }
    }

    // 3. What do they already have?
    const exRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/holdings?user_id=eq.${user.id}&select=id,ticker,source`,
      { headers: sbHeaders() }
    );
    const existing = await exRes.json();
    const byTicker = new Map((existing || []).map((h) => [h.ticker, h]));

    let updated = 0;
    let imported = 0;
    const now = new Date().toISOString();

    for (const pos of found.values()) {
      const match = byTicker.get(pos.ticker);

      if (match) {
        // Update the market facts only. Dividend settings stay untouched.
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/holdings?id=eq.${match.id}`, {
          method: "PATCH",
          headers: sbHeaders(),
          body: JSON.stringify({
            shares: pos.shares,
            price: pos.price || undefined,
            cost: pos.cost || undefined,
            name: pos.name || undefined,
            source: "brokerage",
            last_synced_at: now,
          }),
        });
        updated++;
      } else {
        const ins = await fetch(`${process.env.SUPABASE_URL}/rest/v1/holdings`, {
          method: "POST",
          headers: sbHeaders(),
          body: JSON.stringify({
            user_id: user.id,
            ticker: pos.ticker,
            name: pos.name,
            shares: pos.shares,
            price: pos.price,
            cost: pos.cost,
            div: 0,
            freq: "Q",
            sector: "Other",
            anchor: 2,
            source: "brokerage",
            last_synced_at: now,
          }),
        });
        if (ins.ok) imported++;
        else console.error("insert failed:", (await ins.text()).slice(0, 200));
      }
    }

    await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
      method: "PATCH",
      headers: sbHeaders(),
      body: JSON.stringify({ snaptrade_connected_at: now, snaptrade_brokerage: brokerName }),
    });

    return res.status(200).json({
      accounts: accounts.length,
      imported,
      updated,
      brokerage: brokerName,
      // Positions arrive without dividend data — that still needs filling in.
      needsDividendInfo: imported,
    });
  } catch (err) {
    console.error("snaptrade-sync error:", err?.responseBody || err.message);
    return res.status(500).json({ error: err?.responseBody?.detail || err.message });
  }
}
