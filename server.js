import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

/* ===== 環境変数 ===== */
const PORT = process.env.PORT || 8080;
const { OANDA_ACCOUNT_ID, OANDA_API_KEY } = process.env;

const BASE = "https://api-fxtrade.oanda.com/v3/accounts";
const FIXED_UNITS = 25000;
const RR_MULTIPLIER = 2;

const PRECISION = {
  USD_JPY: 3
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ===== 共通headers ===== */
const headers = {
  Authorization: `Bearer ${OANDA_API_KEY}`,
  "Content-Type": "application/json"
};

/* ===== ポジション取得 ===== */
async function getOpenPosition(symbol) {

  const res = await fetch(
    `${BASE}/${OANDA_ACCOUNT_ID}/positions/${symbol}`,
    { headers }
  );

  const data = await res.json();

  const longUnits = Number(data.position.long.units);
  const shortUnits = Number(data.position.short.units);

  if (longUnits > 0) {
    return "LONG";
  }

  if (shortUnits < 0) {
    return "SHORT";
  }

  return null;
}

/* ===== ポジション決済 ===== */
async function closePosition(symbol) {

  console.log("🚪 ポジション決済");

  const res = await fetch(
    `${BASE}/${OANDA_ACCOUNT_ID}/positions/${symbol}/close`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        longUnits: "ALL",
        shortUnits: "ALL"
      })
    }
  );

  const data = await res.json();

  console.log("決済結果", data);

  await sleep(500);
}

/* ===== 注文 ===== */
async function createOrder(symbol, side, entry, sl) {

  const precision = PRECISION[symbol] || 3;

  const risk = Math.abs(entry - sl);
  const tp =
    side === "LONG"
      ? entry + risk * RR_MULTIPLIER
      : entry - risk * RR_MULTIPLIER;

  const units = side === "LONG" ? FIXED_UNITS : -FIXED_UNITS;

  const order = {
    order: {
      instrument: symbol,
      units: units.toString(),
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

  console.log("📤 注文送信", order);

  const res = await fetch(
    `${BASE}/${OANDA_ACCOUNT_ID}/orders`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(order)
    }
  );

  const data = await res.json();

  console.log("📊 OANDA応答", data);
}

/* ===== Webhook ===== */
app.post("/webhook", async (req, res) => {

  try {

    console.log("📩 Webhook:", req.body);

    const {
      alert,
      symbol,
      entryPrice,
      stopLossPrice
    } = req.body;

    if (!alert) {
      return res.send("no alert");
    }

    /* ===== ZONE EXIT ===== */
    if (alert === "ZONE_EXIT") {

      await closePosition(symbol);

      return res.send("closed");
    }

    /* ===== LONG / SHORT ===== */

    const side =
      alert === "LONG_LIMIT"
        ? "LONG"
        : alert === "SHORT_LIMIT"
        ? "SHORT"
        : null;

    if (!side) {
      return res.send("unknown alert");
    }

    const position = await getOpenPosition(symbol);

    /* ===== 反対ポジションなら決済 ===== */

    if (side === "LONG" && position === "SHORT") {

      console.log("⚠️ SHORT保有 → 決済");

      await closePosition(symbol);
    }

    if (side === "SHORT" && position === "LONG") {

      console.log("⚠️ LONG保有 → 決済");

      await closePosition(symbol);
    }

    await createOrder(
      symbol,
      side,
      Number(entryPrice),
      Number(stopLossPrice)
    );

    res.send("order sent");

  } catch (err) {

    console.error("❌ ERROR", err);

    res.status(500).send("error");
  }
});

/* ===== 起動 ===== */

app.get("/", (req, res) => {
  res.send("BOT RUNNING");
});

app.listen(PORT, () => {
  console.log(`🚀 Server running ${PORT}`);
});
