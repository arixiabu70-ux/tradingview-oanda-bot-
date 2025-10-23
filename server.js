import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const OANDA_API_URL = process.env.OANDA_API_URL || "https://api-fxtrade.oanda.com/v3";
const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const API_KEY = process.env.OANDA_API_KEY;

// Webhook受信
app.post("/webhook", async (req, res) => {
  const body = req.body;
  console.log("✅ Webhook received:", body);

  const alertType = body.alert;
  const symbol = body.symbol || "USD_JPY";
  const units = body.units || 1000; // デフォルト1000（指定なければ）
  const entryPrice = body.entryPrice;
  const stopLoss = body.stopLossPrice;
  const takeProfit = body.takeProfitPrice;

  try {
    if (alertType === "LONG_ENTRY") {
      console.log("📈 Sending BUY order...");
      await sendOrder(symbol, units, "buy", entryPrice, stopLoss, takeProfit);
    } 
    else if (alertType === "SHORT_ENTRY") {
      console.log("📉 Sending SELL order...");
      await sendOrder(symbol, units, "sell", entryPrice, stopLoss, takeProfit);
    } 
    else if (alertType === "LONG_EXIT_ZLSMA" || alertType === "SHORT_EXIT_ZLSMA") {
      console.log("💰 Closing all open positions...");
      await closeAllPositions(symbol);
    } 
    else {
      console.warn("⚠️ Unknown alert type:", alertType);
    }

    res.send("✅ Webhook processed");
  } catch (err) {
    console.error("❌ Error processing webhook:", err);
    res.status(500).send("Error executing order");
  }
});

// === OANDA発注関数 ===
async function sendOrder(symbol, units, side, entry, sl, tp) {
  const orderData = {
    order: {
      instrument: symbol,
      units: side === "buy" ? units : -units,
      type: "MARKET",
      positionFill: "DEFAULT",
      takeProfitOnFill: tp ? { price: tp.toFixed(3) } : undefined,
      stopLossOnFill: sl ? { price: sl.toFixed(3) } : undefined
    }
  };

  const res = await fetch(`${OANDA_API_URL}/accounts/${ACCOUNT_ID}/orders`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(orderData)
  });

  const data = await res.json();
  console.log("📦 Order result:", data);
}

// === ポジションクローズ ===
async function closeAllPositions(symbol) {
  const res = await fetch(`${OANDA_API_URL}/accounts/${ACCOUNT_ID}/positions/${symbol}/close`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ longUnits: "ALL", shortUnits: "ALL" })
  });

  const data = await res.json();
  console.log("💾 Close result:", data);
}

app.listen(8080, () => console.log("🚀 Server running on port 8080"));
