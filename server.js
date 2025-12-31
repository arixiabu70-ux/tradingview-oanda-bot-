// server.js（OANDA SAFE 完成版・最終）
// Node.js v18+
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const { OANDA_ACCOUNT_ID, OANDA_API_KEY } = process.env;

if (!OANDA_ACCOUNT_ID || !OANDA_API_KEY) {
  console.error("❌ OANDA_ACCOUNT_ID or OANDA_API_KEY missing");
  process.exit(1);
}

const OANDA_API_URL = "https://api-fxtrade.oanda.com/v3/accounts";

// ======================
// 設定（SAFE）
// ======================
const FIXED_UNITS = 20000;
const MIN_SLTP_PIPS = 0.015;     // 15分足向け（約1.5pips）
const ORDER_COOLDOWN_MS = 60_000;
const EXIT_GRACE_MS = 800;
const EPS = 0.005;

const PRECISION_MAP = {
  USD_JPY: 3,
  EUR_USD: 5
};

let lastOrderTime = {};
let lastExitTime  = {};

// ======================
// ヘルパー
// ======================
const fmtPrice = (p, s="USD_JPY") =>
  Number(p).toFixed(PRECISION_MAP[s] ?? 3);

async function fetchJSON(url, options={}) {
  const res = await fetch(url, options);
  const text = await res.text();
  console.log(`📥 ${res.status} ${url}`);
  console.log(text);
  if (!res.ok) throw new Error(text);
  return JSON.parse(text);
}

const auth = { Authorization: `Bearer ${OANDA_API_KEY}` };

async function getCurrentMidPrice(symbol) {
  const d = await fetchJSON(
    `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/pricing?instruments=${symbol}`,
    { headers: auth }
  );
  const p = d.prices[0];
  return (Number(p.closeoutBid) + Number(p.closeoutAsk)) / 2;
}

async function getOpenPosition(symbol) {
  const d = await fetchJSON(
    `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/openPositions`,
    { headers: auth }
  );
  return d.positions?.find(p => p.instrument === symbol) ?? null;
}

async function getPendingOrders(symbol) {
  const d = await fetchJSON(
    `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders`,
    { headers: auth }
  );
  return (d.orders ?? []).filter(
    o => o.instrument === symbol && o.type === "LIMIT"
  );
}

async function cancelAllPendingOrders(symbol) {
  const orders = await getPendingOrders(symbol);
  for (const o of orders) {
    await fetchJSON(
      `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders/${o.id}/cancel`,
      { method: "PUT", headers: auth }
    );
  }
}

async function closePositionAll(symbol) {
  await cancelAllPendingOrders(symbol);

  const pos = await getOpenPosition(symbol);
  if (!pos) return;

  const body = {};
  if (Number(pos.long.units) > 0) body.longUnits = "ALL";
  if (Number(pos.short.units) < 0) body.shortUnits = "ALL";

  await fetchJSON(
    `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/positions/${symbol}/close`,
    {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );
}

async function placeLimit(symbol, units, entry, sl, tp) {
  const body = {
    order: {
      type: "LIMIT",
      instrument: symbol,
      units: units.toString(),
      price: fmtPrice(entry, symbol),
      timeInForce: "GTC",
      positionFill: "DEFAULT", // ★ 修正：新規エントリー対応
      stopLossOnFill: sl ? { price: fmtPrice(sl, symbol) } : undefined,
      takeProfitOnFill: tp ? { price: fmtPrice(tp, symbol) } : undefined
    }
  };

  console.log("📤 PLACE ORDER:", body);

  return fetchJSON(
    `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders`,
    {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );
}

// ======================
// Webhook
// ======================
app.post("/webhook", async (req, res) => {
  try {
    const payload = req.body.alert_message
      ? JSON.parse(req.body.alert_message)
      : req.body;

    console.log("📬 WEBHOOK:", payload);

    const {
      alert,
      symbol,
      entryPrice,
      stopLossPrice,
      takeProfitPrice
    } = payload;

    const now = Date.now();

    // ===== EXIT =====
    if (alert === "EXIT") {
      lastExitTime[symbol] = now;
      lastOrderTime[symbol] = 0;
      await closePositionAll(symbol);
      return res.json({ ok: true, action: "exit" });
    }

    // ===== ガード =====
    if (now - (lastExitTime[symbol] ?? 0) < EXIT_GRACE_MS)
      return res.json({ skipped: "exit grace" });

    if (now - (lastOrderTime[symbol] ?? 0) < ORDER_COOLDOWN_MS)
      return res.json({ skipped: "cooldown" });

    const pos = await getOpenPosition(symbol);
    if (pos) return res.json({ skipped: "position exists" });

    const pending = await getPendingOrders(symbol);
    if (pending.length) return res.json({ skipped: "pending exists" });

    const entry = Number(entryPrice);
    const market = await getCurrentMidPrice(symbol);

    if (Math.abs(entry - market) < MIN_SLTP_PIPS)
      return res.json({ skipped: "too close to market" });

    const units =
      alert === "LONG_LIMIT" ? FIXED_UNITS :
      alert === "SHORT_LIMIT" ? -FIXED_UNITS :
      0;

    if (!units)
      return res.json({ skipped: "unknown alert type" });

    await placeLimit(
      symbol,
      units,
      entry,
      Number(stopLossPrice),
      Number(takeProfitPrice)
    );

    lastOrderTime[symbol] = now;
    return res.json({ ok: true });

  } catch (e) {
    console.error("❌ ERROR:", e);
    return res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 OANDA SAFE BOT running on port ${PORT}`);
});
