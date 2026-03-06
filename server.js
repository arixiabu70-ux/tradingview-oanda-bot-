```javascript
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const { OANDA_ACCOUNT_ID, OANDA_API_KEY } = process.env;

const BASE = "https://api-fxtrade.oanda.com/v3/accounts";
const FIXED_UNITS = 25000;

const RR = 2;

const PRECISION = { USD_JPY: 3 };

const COOLDOWN_MS = 8000;
const POST_CLOSE_WAIT = 3000;

let processing = false;

let lastEntryTime = 0;
let lastEntrySide = null;

const auth = {
  Authorization: `Bearer ${OANDA_API_KEY}`,
  "Content-Type": "application/json"
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (p, s) => Number(p).toFixed(PRECISION[s] ?? 3);

// ==================================================
async function fetchJSON(url, options = {}) {

  const res = await fetch(url, options);
  const text = await res.text();

  console.log(`📡 ${options.method} ${url}`);
  console.log(`📥 [${res.status}] ${text}`);

  try { return JSON.parse(text); }
  catch { return {}; }
}

// ==================================================
async function getPosition(symbol) {

  const r = await fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/openPositions`,
    { method: "GET", headers: auth }
  );

  const pos = (r.positions ?? []).find(p => p.instrument === symbol);

  if (!pos) return null;

  return {
    long: parseInt(pos.long.units),
    short: parseInt(pos.short.units)
  };
}

// ==================================================
async function closeAllSafe(symbol) {

  const pos = await getPosition(symbol);

  if (!pos) {
    console.log("ℹ ポジション無し");
    return true;
  }

  let unitsToClose = 0;

  if (pos.long > 0) unitsToClose = -pos.long;
  if (pos.short < 0) unitsToClose = -pos.short;

  if (unitsToClose === 0) return true;

  const body = {
    order: {
      type: "MARKET",
      instrument: symbol,
      units: unitsToClose.toString(),
      timeInForce: "FOK",
      positionFill: "DEFAULT"
    }
  };

  const r = await fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/orders`,
    {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body)
    }
  );

  if (r.orderFillTransaction) {
    console.log("✅ MARKETクローズ成功");
    return true;
  }

  console.log("❌ MARKETクローズ失敗");
  return false;
}

// ==================================================
async function cancelAll(symbol) {

  const r = await fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/pendingOrders`,
    { method: "GET", headers: auth }
  );

  for (const o of r.orders ?? []) {

    if (o.instrument === symbol) {

      await fetchJSON(
        `${BASE}/${OANDA_ACCOUNT_ID}/orders/${o.id}/cancel`,
        { method: "PUT", headers: auth }
      );

    }

  }

}

// ==================================================
async function placeLimit(symbol, units, entry) {

  return fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/orders`,
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
          positionFill: "OPEN_ONLY"
        }
      })
    }
  );
}

// ==================================================
// 約定価格取得
async function getLastFill(symbol) {

  const r = await fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/trades?instrument=${symbol}&count=1`,
    { method: "GET", headers: auth }
  );

  if (!r.trades || r.trades.length === 0) return null;

  return r.trades[0];
}

// ==================================================
async function attachTPSL(symbol, tradeID, entry, slPrice, side) {

  const risk = Math.abs(entry - slPrice);

  let tp;

  if (side === "LONG")
    tp = entry + risk * RR;
  else
    tp = entry - risk * RR;

  const body = {
    stopLoss: {
      price: fmt(slPrice, symbol),
      timeInForce: "GTC"
    },
    takeProfit: {
      price: fmt(tp, symbol),
      timeInForce: "GTC"
    }
  };

  await fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/trades/${tradeID}/orders`,
    {
      method: "PUT",
      headers: auth,
      body: JSON.stringify(body)
    }
  );

  console.log("🎯 TP/SL後付け完了");
}

// ==================================================
function cooldownActive(side) {

  if (!lastEntrySide) return false;
  if (side !== lastEntrySide) return false;

  return Date.now() - lastEntryTime < COOLDOWN_MS;
}

// ==================================================
app.post("/webhook", async (req, res) => {

  if (processing) {
    console.log("⚠ 多重Webhook防止");
    return res.json({ skipped: true });
  }

  processing = true;

  try {

    const payload = req.body.alert_message
      ? JSON.parse(req.body.alert_message)
      : req.body;

    console.log("📬 WEBHOOK:", payload);

    const {
      alert,
      symbol,
      entryPrice,
      stopLossPrice
    } = payload;

    if (!symbol) return res.json({ skipped: true });

    // ==================================================
    if (alert === "ZONE_EXIT") {

      console.log("🚪 ZONE_EXIT");

      await cancelAll(symbol);

      const success = await closeAllSafe(symbol);

      if (!success)
        return res.status(500).json({ error: "close failed" });

      await sleep(POST_CLOSE_WAIT);

      lastEntrySide = null;

      return res.json({ ok: true });

    }

    // ==================================================
    const side =
      alert === "LONG_LIMIT" ? "LONG" :
      alert === "SHORT_LIMIT" ? "SHORT" : null;

    if (!side) return res.json({ skipped: true });

    const units = side === "LONG" ? FIXED_UNITS : -FIXED_UNITS;

    if (cooldownActive(side)) {
      console.log("⏳ 同方向クールダウン");
      return res.json({ skipped: true });
    }

    await cancelAll(symbol);

    const pos = await getPosition(symbol);

    if (pos && (
      (side === "LONG" && pos.short < 0) ||
      (side === "SHORT" && pos.long > 0)
    )) {

      console.log("🔁 反転エントリー");

      const success = await closeAllSafe(symbol);

      if (!success)
        return res.status(500).json({ error: "close failed" });

      await sleep(POST_CLOSE_WAIT);
    }

    await placeLimit(symbol, units, Number(entryPrice));

    console.log("📌 LIMIT発注");

    await sleep(2000);

    const trade = await getLastFill(symbol);

    if (trade) {

      const entry = Number(trade.price);

      await attachTPSL(
        symbol,
        trade.id,
        entry,
        Number(stopLossPrice),
        side
      );

    }

    lastEntryTime = Date.now();
    lastEntrySide = side;

    return res.json({ ok: true });

  } catch (err) {

    console.error("❌ ERROR:", err);
    return res.status(500).json({ error: true });

  } finally {

    processing = false;

  }

});

app.listen(PORT, () =>
  console.log("🚀 Zone Ultra Safe Institutional Version v7 (Real Fill RR)")
);
```
