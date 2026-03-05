import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

const { OANDA_ACCOUNT_ID, OANDA_API_KEY } = process.env;

const BASE = "https://api-fxtrade.oanda.com/v3/accounts";

const FIXED_UNITS = 25000;
const RR_MULTIPLIER = 2;

const PRECISION = {
  USD_JPY: 3
};

const COOLDOWN_MS = 8000;

let processing = false;
let lastEntryTime = 0;
let lastEntrySide = null;

const auth = {
  Authorization: `Bearer ${OANDA_API_KEY}`,
  "Content-Type": "application/json"
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const fmt = (p, s) => Number(p).toFixed(PRECISION[s] ?? 3);

/* ================================================== */

async function fetchJSON(url, options = {}) {

  const res = await fetch(url, options);
  const text = await res.text();

  console.log(`📡 ${options.method || "GET"} ${url}`);
  console.log(`📥 [${res.status}] ${text}`);

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }

}

/* ================================================== */

async function getOpenTrade(symbol) {

  const r = await fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/openTrades`,
    { method: "GET", headers: auth }
  );

  return (r.trades ?? []).find(t => t.instrument === symbol);

}

/* ================================================== */

async function setTakeProfit(symbol) {

  let trade = null;

  for (let i = 0; i < 10; i++) {

    await sleep(1000);

    trade = await getOpenTrade(symbol);

    if (trade) break;

  }

  if (!trade) {

    console.log("⚠ 約定確認できず TP未設定");

    return;

  }

  const entry = Number(trade.price);
  const sl = Number(trade.stopLossOrder.price);
  const units = Number(trade.currentUnits);

  const risk = Math.abs(entry - sl);

  const tp =
    units > 0
      ? entry + risk * RR_MULTIPLIER
      : entry - risk * RR_MULTIPLIER;

  await fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/orders`,
    {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        order: {
          type: "TAKE_PROFIT",
          tradeID: trade.id,
          price: fmt(tp, symbol),
          timeInForce: "GTC"
        }
      })
    }
  );

  console.log("✅ TP再計算セット完了:", tp);

}

/* ================================================== */

async function placeLimit(symbol, units, entry, sl) {

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
          stopLossOnFill: {
            price: fmt(sl, symbol)
          }
        }
      })
    }
  );

}

/* ================================================== */

function cooldownActive(side) {

  if (!lastEntrySide) return false;

  if (side !== lastEntrySide) return false;

  return Date.now() - lastEntryTime < COOLDOWN_MS;

}

/* ================================================== */

app.post("/webhook", async (req, res) => {

  if (processing) {
    return res.json({ skipped: true });
  }

  processing = true;

  try {

    const payload = req.body.alert_message
      ? JSON.parse(req.body.alert_message)
      : req.body;

    const { alert, symbol, entryPrice, stopLossPrice } = payload;

    console.log("📩 Webhook:", payload);

    if (!symbol) {
      return res.json({ skipped: true });
    }

    if (alert === "ZONE_EXIT") {

      await fetchJSON(
        `${BASE}/${OANDA_ACCOUNT_ID}/positions/${symbol}/close`,
        {
          method: "PUT",
          headers: auth,
          body: JSON.stringify({
            longUnits: "ALL",
            shortUnits: "ALL"
          })
        }
      );

      lastEntrySide = null;

      return res.json({ ok: true });

    }

    const side =
      alert === "LONG_LIMIT"
        ? "LONG"
        : alert === "SHORT_LIMIT"
        ? "SHORT"
        : null;

    if (!side) {
      return res.json({ skipped: true });
    }

    if (cooldownActive(side)) {
      return res.json({ skipped: true });
    }

    const units = side === "LONG"
      ? FIXED_UNITS
      : -FIXED_UNITS;

    await placeLimit(
      symbol,
      units,
      Number(entryPrice),
      Number(stopLossPrice)
    );

    console.log("🚀 LIMIT発注完了（SLのみ）");

    await setTakeProfit(symbol);

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

/* ================================================== */

app.listen(PORT, () => {
  console.log("🚀 Zone Ultra Safe Institutional Version v7 (True RR Fixed)");
});
