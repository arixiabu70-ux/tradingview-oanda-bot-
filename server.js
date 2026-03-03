import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

/* ====== 環境変数 ====== */
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const OANDA_API_KEY = process.env.OANDA_API_KEY;
const BASE = "https://api-fxtrade.oanda.com/v3";
const auth = {
  Authorization: `Bearer ${OANDA_API_KEY}`,
  "Content-Type": "application/json"
};

const RR = 2.0;
const POST_CLOSE_WAIT = 1200;
const POST_ORDER_WAIT = 1200;

/* ====== ユーティリティ ====== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) {
    console.error("❌ OANDA ERROR:", text);
    throw new Error(text);
  }
  return JSON.parse(text);
}

async function getOpenTrade(symbol) {
  const data = await fetchJSON(
    `${BASE}/accounts/${OANDA_ACCOUNT_ID}/openTrades`,
    { headers: auth }
  );
  return data.trades.find((t) => t.instrument === symbol);
}

/* ====== 反対ポジ強制クローズ ====== */
async function closeOppositePosition(symbol, side) {
  const pos = await getOpenTrade(symbol);
  if (!pos) return;

  const currentUnits = Number(pos.currentUnits);

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

/* ====== LIMIT発注（SLのみ） ====== */
async function placeLimit(symbol, side, units, entryPrice, slPrice) {
  const order = {
    order: {
      type: "LIMIT",
      instrument: symbol,
      units: side === "LONG" ? units : -units,
      price: entryPrice.toFixed(3),
      timeInForce: "GTC",
      positionFill: "DEFAULT",
      stopLossOnFill: {
        price: slPrice.toFixed(3)
      }
    }
  };

  return await fetchJSON(
    `${BASE}/accounts/${OANDA_ACCOUNT_ID}/orders`,
    {
      method: "POST",
      headers: auth,
      body: JSON.stringify(order)
    }
  );
}

/* ====== 約定待ち ====== */
async function waitForFill(symbol) {
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    const trade = await getOpenTrade(symbol);
    if (trade) return trade;
  }
  throw new Error("約定確認できませんでした");
}

/* ====== TP再設定 ====== */
async function setTakeProfit(trade, side) {
  const entry = Number(trade.price);
  const sl = Number(trade.stopLossOrder.price);
  const risk = Math.abs(entry - sl);
  const tp =
    side === "LONG"
      ? entry + risk * RR
      : entry - risk * RR;

  console.log("🎯 TP再計算:", tp.toFixed(3));

  await fetchJSON(
    `${BASE}/accounts/${OANDA_ACCOUNT_ID}/trades/${trade.id}/orders`,
    {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        takeProfit: {
          price: tp.toFixed(3)
        }
      })
    }
  );
}

/* ====== Webhook受信 ====== */
app.post("/webhook", async (req, res) => {
  try {
    const { symbol, side, units, entryPrice, slPrice } = req.body;

    console.log("📩 Webhook:", req.body);

    // ① 反対ポジがあればクローズ
    await closeOppositePosition(symbol, side);

    // ② LIMIT発注
    await placeLimit(symbol, side, units, entryPrice, slPrice);

    await sleep(POST_ORDER_WAIT);

    // ③ 約定確認
    const trade = await waitForFill(symbol);

    // ④ TP再計算
    await setTakeProfit(trade, side);

    res.json({ status: "OK" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
