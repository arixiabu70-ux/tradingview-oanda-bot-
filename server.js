import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const { OANDA_ACCOUNT_ID, OANDA_API_KEY } = process.env;

const BASE = "https://api-fxtrade.oanda.com/v3/accounts";
const FIXED_UNITS = 20000;

const PRECISION = { USD_JPY: 3 };

const COOLDOWN_MS = 8000;
const POST_CLOSE_WAIT = 3000;

let processing = false;
let lastCloseTime = 0;

const auth = {
  Authorization: `Bearer ${OANDA_API_KEY}`,
  "Content-Type": "application/json"
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (p, s) => Number(p).toFixed(PRECISION[s] ?? 3);

// ==============================
async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  console.log(`📡 ${options.method} ${url}`);
  console.log(`📥 [${res.status}] ${text}`);
  try { return JSON.parse(text); } catch { return {}; }
}

// ==============================
// 現在ポジション取得（units付き）
// ==============================
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

// ==============================
// NETTING口座用 成り行きクローズ
// ==============================
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

// ==============================
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

// ==============================
async function placeLimit(symbol, units, entry, sl, tp) {

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
          positionFill: "OPEN_ONLY",
          stopLossOnFill: { price: fmt(sl, symbol) },
          takeProfitOnFill: { price: fmt(tp, symbol) }
        }
      })
    }
  );
}

function cooldownActive() {
  return Date.now() - lastCloseTime < COOLDOWN_MS;
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
      stopLossPrice,
      takeProfitPrice
    } = payload;

    if (!symbol) return res.json({ skipped: true });

    // ==============================
    // ZONE_EXIT
    // ==============================
    if (alert === "ZONE_EXIT") {

      console.log("🚪 ZONE_EXIT");

      await cancelAll(symbol);

      const success = await closeAllSafe(symbol);

      if (!success) {
        return res.status(500).json({ error: "close failed" });
      }

      await sleep(POST_CLOSE_WAIT);
      lastCloseTime = Date.now();

      return res.json({ ok: true });
    }

    // ==============================
    // ENTRY
    // ==============================
    const units =
      alert === "LONG_LIMIT"  ?  FIXED_UNITS :
      alert === "SHORT_LIMIT" ? -FIXED_UNITS : 0;

    if (!units) return res.json({ skipped: true });

    if (cooldownActive()) {
      console.log("⏳ クールダウン中");
      return res.json({ skipped: true });
    }

    await cancelAll(symbol);

    const pos = await getPosition(symbol);

    if (pos && (pos.long !== 0 || pos.short !== 0)) {

      console.log("🔁 反転処理開始");

      const success = await closeAllSafe(symbol);

      if (!success) {
        return res.status(500).json({ error: "close failed" });
      }

      await sleep(POST_CLOSE_WAIT);
      lastCloseTime = Date.now();
    }

    if (cooldownActive()) {
      console.log("⏳ 反転直後クールダウン");
      return res.json({ skipped: true });
    }

    await placeLimit(
      symbol,
      units,
      Number(entryPrice),
      Number(stopLossPrice),
      Number(takeProfitPrice)
    );

    console.log("🚀 新規LIMIT発注完了");

    return res.json({ ok: true });

  } catch (err) {

    console.error("❌ ERROR:", err);
    return res.status(500).json({ error: true });

  } finally {
    processing = false;
  }
});

app.listen(PORT, () =>
  console.log("🚀 Zone Ultra Safe Institutional Version running (NETTING FIXED)")
);
