import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

/* ====== 環境変数 ====== */
const PORT = process.env.PORT || 8080;
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const OANDA_API_KEY = process.env.OANDA_API_KEY;

const BASE = "https://api-fxtrade.oanda.com/v3";
const FIXED_UNITS = 25000;
const RR_MULTIPLIER = 2;

const PRECISION = { USD_JPY: 3 };

const COOLDOWN_MS = 8000;
const POST_CLOSE_WAIT = 1200;
const POST_ORDER_WAIT = 1200;

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

  if (!res.ok) {
    throw new Error(text);
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/* ================================================== */

async function getOpenTrade(symbol) {
  const r = await fetchJSON(
    `${BASE}/accounts/${OANDA_ACCOUNT_ID}/openTrades`,
    { method: "GET", headers: auth }
  );
  return (r.trades ?? []).find(t => t.instrument === symbol);
}

/* ================================================== */

async function closeOppositePosition(symbol, side) {
  const trade = await getOpenTrade(symbol);
  if (!trade) return;

  const currentUnits = Number(trade.currentUnits);

  if (
    (side === "LONG" && currentUnits < 0) ||
    (side === "SHORT" && currentUnits > 0)
  ) {
    console.log("🔁 反対ポジ検出 → 強制クローズ");

    await fetchJSON(
      `${BASE}/accounts/${OANDA_ACCOUNT_ID}/positions/${symbol}/close`,
      {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({
          longUnits: "ALL",
          shortUnits: "ALL"
        })
      }
    );

    await sleep(POST_CLOSE_WAIT);
  }
}

/* ================================================== */

async function placeLimit(symbol, side, entry, sl) {
  const units = side === "LONG" ? FIXED_UNITS : -FIXED_UNITS;

  return fetchJSON(
    `${BASE}/accounts/${OANDA_ACCOUNT_ID}/orders`,
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
          }
        }
      })
    }
  );
}

/* ================================================== */

async function waitForFill(symbol) {
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    const trade = await getOpenTrade(symbol);
    if (trade) return trade;
  }
  throw new Error("約定確認できませんでした");
}

/* ================================================== */

async function setTakeProfit(trade, side) {
  const entry = Number(trade.price);
  const sl = Number(trade.stopLossOrder.price);
  const risk = Math.abs(entry - sl);

  const tp =
    side === "LONG"
      ? entry + risk * RR_MULTIPLIER
      : entry - risk * RR_MULTIPLIER;

  console.log("🎯 TP再計算:", tp);

  await fetchJSON(
    `${BASE}/accounts/${OANDA_ACCOUNT_ID}/trades/${trade.id}/orders`,
    {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        takeProfit: {
          price: fmt(tp, trade.instrument)
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

    console.log("📩 Webhook:", payload);

    const { alert, symbol, entryPrice, stopLossPrice } = payload;

    if (!symbol) return res.json({ skipped: true });

    if (alert === "ZONE_EXIT") {
      await fetchJSON(
        `${BASE}/accounts/${OANDA_ACCOUNT_ID}/positions/${symbol}/close`,
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

    if (!side) return res.json({ skipped: true });

    if (cooldownActive(side)) {
      return res.json({ skipped: true });
    }

    await closeOppositePosition(symbol, side);

    await placeLimit(
      symbol,
      side,
      Number(entryPrice),
      Number(stopLossPrice)
    );

    console.log("🚀 LIMIT発注完了");

    await sleep(POST_ORDER_WAIT);

    const trade = await waitForFill(symbol);

    await setTakeProfit(trade, side);

    lastEntryTime = Date.now();
    lastEntrySide = side;

    res.json({ ok: true });

  } catch (err) {
    console.error("❌ ERROR:", err);
    res.status(500).json({ error: err.message });
  } finally {
    processing = false;
  }
});

/* ================================================== */

app.listen(PORT, () => {
  console.log(`🚀 Zone Ultra Safe Institutional Version v7 running on port ${PORT}`);
});
