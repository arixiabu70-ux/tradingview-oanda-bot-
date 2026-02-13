import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const { OANDA_ACCOUNT_ID, OANDA_API_KEY } = process.env;

const OANDA_API_URL = "https://api-fxtrade.oanda.com/v3/accounts";
const FIXED_UNITS = 20000;

const PRECISION = { USD_JPY: 3 };

const auth = {
  Authorization: `Bearer ${OANDA_API_KEY}`,
  "Content-Type": "application/json"
};

const fmt = (p, s) => Number(p).toFixed(PRECISION[s] ?? 3);

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  console.log(`📡 ${options.method} ${url}`);
  console.log(`📥 [${res.status}] ${text}`);
  try { return JSON.parse(text); } catch { return {}; }
}

// ==============================
// ポジション有無チェック
// ==============================
async function hasPosition(symbol) {
  const r = await fetchJSON(
    `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/openPositions`,
    { method: "GET", headers: auth }
  );
  return (r.positions ?? []).some(p => p.instrument === symbol);
}

// ==============================
// 全決済
// ==============================
async function closeAll(symbol) {
  return fetchJSON(
    `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/positions/${symbol}/close`,
    {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        longUnits: "ALL",
        shortUnits: "ALL"
      })
    }
  );
}

// ==============================
// 指値キャンセル
// ==============================
async function cancelAll(symbol) {
  const r = await fetchJSON(
    `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/pendingOrders`,
    { method: "GET", headers: auth }
  );

  for (const o of r.orders ?? []) {
    if (o.instrument === symbol) {
      await fetchJSON(
        `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders/${o.id}/cancel`,
        { method: "PUT", headers: auth }
      );
    }
  }
}

// ==============================
// LIMIT注文
// ==============================
async function placeLimit(symbol, units, entry, sl, tp) {
  return fetchJSON(
    `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders`,
    {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        order: {
          type: "LIMIT",
          instrument: symbol,
          units: units.toString(),
          price: fmt(entry, symbol),
          timeInForce: "GTC",
          positionFill: "DEFAULT",
          stopLossOnFill: {
            price: fmt(sl, symbol)
          },
          takeProfitOnFill: {
            price: fmt(tp, symbol)
          }
        }
      })
    }
  );
}

// ==================================================
// WEBHOOK
// ==================================================
app.post("/webhook", async (req, res) => {

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

  // ==============================
  // ZONE EXIT（決済専用）
  // ==============================
  if (alert === "ZONE_EXIT") {

    // まず未約定指値を消す
    await cancelAll(symbol);

    // ポジションがあれば決済
    if (await hasPosition(symbol)) {
      await closeAll(symbol);
    }

    return res.json({ ok: true });
  }

  // ==============================
  // ENTRY（★ここが修正点）
  // ==============================

  const units =
    alert === "LONG_LIMIT"  ?  FIXED_UNITS :
    alert === "SHORT_LIMIT" ? -FIXED_UNITS : 0;

  if (!units) return res.json({ skipped: true });

  // 既存指値のみキャンセル
  await cancelAll(symbol);

  // ❌ ここでcloseしない（超重要）
  // ENTRYでは決済しない
  // ZONE_EXITでのみ決済する

  await placeLimit(
    symbol,
    units,
    Number(entryPrice),
    Number(stopLossPrice),
    Number(takeProfitPrice)
  );

  return res.json({ ok: true });
});

app.listen(PORT, () =>
  console.log("🚀 Zone + RR AutoTrade SAFE BOT running")
);
