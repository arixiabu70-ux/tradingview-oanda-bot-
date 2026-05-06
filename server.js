import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const { OANDA_ACCOUNT_ID, OANDA_API_KEY } = process.env;

const BASE = "https://api-fxtrade.oanda.com/v3/accounts";

const FIXED_UNITS = 20000;
const SL_PIPS = 20;
const RR = 2;
const WAIT = 2000;
const COOLDOWN = 8000;

let processing = false;
let lastTime = 0;

const auth = {
  Authorization: `Bearer ${OANDA_API_KEY}`,
  "Content-Type": "application/json"
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function normalizeSymbol(sym) {
  if (sym === "USDJPY") return "USD_JPY";
  if (sym === "EURJPY") return "EUR_JPY";
  if (sym === "GBPJPY") return "GBP_JPY";
  return sym;
}

function getPip(symbol) {
  return symbol.includes("JPY") ? 0.01 : 0.0001;
}

function formatPrice(price, symbol) {
  const precision = symbol.includes("JPY") ? 3 : 5;
  return Number(price).toFixed(precision);
}

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();

  console.log(`📡 ${options.method} ${url}`);
  console.log(`📥 [${res.status}] ${text}`);

  try { return JSON.parse(text); }
  catch { return {}; }
}

/* =============================
   ポジション取得
============================= */
async function getTrade(symbol) {
  const r = await fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/openTrades`,
    { method: "GET", headers: auth }
  );

  return (r.trades ?? []).find(t => t.instrument === symbol);
}

/* =============================
   注文削除
============================= */
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

/* =============================
   全決済
============================= */
async function closeAll(symbol) {
  const trade = await getTrade(symbol);
  if (!trade) return;

  const units = -parseInt(trade.currentUnits);

  await fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/orders`,
    {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        order: {
          type: "MARKET",
          instrument: symbol,
          units: units.toString(),
          timeInForce: "FOK",
          positionFill: "DEFAULT"
        }
      })
    }
  );

  console.log("✅ クローズ完了");
}

/* =============================
   エントリー（SLのみ）
============================= */
async function entry(symbol, side) {

  const pip = getPip(symbol);
  const units = side === "LONG" ? FIXED_UNITS : -FIXED_UNITS;

  return fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/orders`,
    {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        order: {
          type: "MARKET",
          instrument: symbol,
          units: units.toString(),
          timeInForce: "FOK",
          positionFill: "DEFAULT",
          stopLossOnFill: {
            distance: (pip * SL_PIPS).toString()
          }
        }
      })
    }
  );
}

/* =============================
   RR設定（直近＋最低保証）
============================= */
async function setRR(symbol, side, payload) {

  await sleep(WAIT);

  const trade = await getTrade(symbol);
  if (!trade) {
    console.log("❌ トレードなし");
    return;
  }

  const entry = Number(trade.price);
  const tradeID = trade.id;
  const pip = getPip(symbol);

  let baseRisk;

  if (side === "LONG") {
    const recentLow = Number(payload.recentLow);
    baseRisk = entry - recentLow;
  } else {
    const recentHigh = Number(payload.recentHigh);
    baseRisk = recentHigh - entry;
  }

  const minRisk = pip * SL_PIPS;
  const risk = Math.max(baseRisk, minRisk);

  let sl, tp;

  if (side === "LONG") {
    sl = entry - risk;
    tp = entry + risk * RR;
  } else {
    sl = entry + risk;
    tp = entry - risk * RR;
  }

  sl = formatPrice(sl, symbol);
  tp = formatPrice(tp, symbol);

  console.log(`🎯 SL:${sl} TP:${tp}`);

  await cancelAll(symbol);

  await fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/trades/${tradeID}/orders`,
    {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        takeProfit: { price: tp },
        stopLoss: { price: sl }
      })
    }
  );

  console.log("✅ RR設定完了");
}

/* =============================
   Webhook
============================= */
app.post("/webhook", async (req, res) => {

  res.json({ ok: true });

  if (processing) {
    console.log("⚠ 多重防止");
    return;
  }

  if (Date.now() - lastTime < COOLDOWN) {
    console.log("⏳ クールダウン");
    return;
  }

  processing = true;

  try {

    const payload = req.body.alert_message
      ? JSON.parse(req.body.alert_message)
      : req.body;

    console.log("📬", payload);

    const { alert, symbol } = payload;
    if (!symbol) return;

    const sym = normalizeSymbol(symbol);

    if (alert === "ZONE_EXIT") {
      await cancelAll(sym);
      await closeAll(sym);
      return;
    }

    if (alert === "LONG_MARKET") {
      await entry(sym, "LONG");
      await setRR(sym, "LONG", payload);
    }

    if (alert === "SHORT_MARKET") {
      await entry(sym, "SHORT");
      await setRR(sym, "SHORT", payload);
    }

    lastTime = Date.now();

  } catch (e) {
    console.error("❌ ERROR", e);
  } finally {
    processing = false;
  }
});

app.listen(PORT, () =>
  console.log("🚀 後付けRR＋直近ベース 完成版")
);
