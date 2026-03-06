import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

/* ===== 環境変数 ===== */
const PORT = process.env.PORT || 8080;
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const OANDA_API_KEY = process.env.OANDA_API_KEY;

/* ===== 設定 ===== */
const BASE = "https://api-fxtrade.oanda.com/v3/accounts";
const FIXED_UNITS = 25000;
const RR_MULTIPLIER = 2;

const PRECISION = {
  USD_JPY: 3
};

/* ===== ヘッダー ===== */
const headers = {
  Authorization: `Bearer ${OANDA_API_KEY}`,
  "Content-Type": "application/json"
};

/* ===== sleep ===== */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ===============================
   現在ポジション取得
================================ */
async function getPosition(symbol) {

  const res = await fetch(
    `${BASE}/${OANDA_ACCOUNT_ID}/positions/${symbol}`,
    { headers }
  );

  const data = await res.json();

  if (!data.position) return "NONE";

  const longUnits = Number(data.position.long.units);
  const shortUnits = Number(data.position.short.units);

  if (longUnits > 0) return "LONG";
  if (shortUnits < 0) return "SHORT";

  return "NONE";
}

/* ===============================
   ポジション決済
================================ */
async function closePosition(symbol) {

  const res = await fetch(
    `${BASE}/${OANDA_ACCOUNT_ID}/positions/${symbol}`,
    { headers }
  );

  const data = await res.json();

  if (!data.position) {
    console.log("ポジションなし");
    return;
  }

  const longUnits = Number(data.position.long.units);
  const shortUnits = Number(data.position.short.units);

  let body = {};

  if (longUnits > 0) {
    body.longUnits = "ALL";
  }

  if (shortUnits < 0) {
    body.shortUnits = "ALL";
  }

  if (Object.keys(body).length === 0) {
    console.log("決済するポジションなし");
    return;
  }

  console.log("決済送信:", body);

  const resClose = await fetch(
    `${BASE}/${OANDA_ACCOUNT_ID}/positions/${symbol}/close`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify(body)
    }
  );

  const result = await resClose.json();

  console.log("決済結果:", result);
}

/* ===============================
   注文送信
================================ */
async function createOrder(symbol, side, entry, sl, tp) {

  const precision = PRECISION[symbol] || 3;

  const order = {
    order: {
      instrument: symbol,
      units: side === "LONG" ? FIXED_UNITS : -FIXED_UNITS,
      type: "LIMIT",
      price: entry.toFixed(precision),
      timeInForce: "GTC",
      positionFill: "DEFAULT",
      stopLossOnFill: {
        price: sl.toFixed(precision)
      },
      takeProfitOnFill: {
        price: tp.toFixed(precision)
      }
    }
  };

  console.log("注文送信:", order);

  const res = await fetch(
    `${BASE}/${OANDA_ACCOUNT_ID}/orders`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(order)
    }
  );

  const data = await res.json();

  console.log("注文結果:", data);
}

/* ===============================
   Webhook
================================ */
app.post("/webhook", async (req, res) => {

  console.log("Webhook受信:", req.body);

  const { alert, symbol, side, entry, sl } = req.body;

  try {

    /* ===== ゾーン決済 ===== */
    if (alert === "ZONE_EXIT") {

      await closePosition(symbol);

      return res.json({ status: "exit done" });
    }

    /* ===== エントリー ===== */
    if (alert === "ENTRY") {

      const position = await getPosition(symbol);

      console.log("現在ポジション:", position);

      if (side === "LONG" && position === "SHORT") {

        await closePosition(symbol);
        await sleep(800);
      }

      if (side === "SHORT" && position === "LONG") {

        await closePosition(symbol);
        await sleep(800);
      }

      const risk = Math.abs(entry - sl);

      let tp;

      if (side === "LONG") {
        tp = entry + risk * RR_MULTIPLIER;
      } else {
        tp = entry - risk * RR_MULTIPLIER;
      }

      await createOrder(symbol, side, entry, sl, tp);

      return res.json({ status: "order sent" });
    }

    res.json({ status: "ignored" });

  } catch (err) {

    console.error("エラー:", err);

    res.status(500).json({
      error: err.message
    });
  }

});

/* ===============================
   サーバー起動
================================ */
app.listen(PORT, () => {

  console.log(`BOT起動ポート ${PORT}`);

});
