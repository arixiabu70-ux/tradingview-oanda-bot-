import express from "express";
import fetchPkg from "node-fetch";
const fetch = fetchPkg.default;

const app = express();
app.use(express.json());

// ===== OANDA設定 =====
const OANDA_API_URL = process.env.OANDA_API_URL || "https://api-fxtrade.oanda.com/v3";
const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const API_KEY = process.env.OANDA_API_KEY;

// ===== Webhook受信 =====
app.post("/webhook", async (req, res) => {
  const data = req.body;
  console.log("✅ Webhook received:", data);

  const { alert, symbol, entryPrice, stopLossPrice, takeProfitPrice, units } = data;
  if (!alert || !symbol) return res.status(400).send("Invalid payload");

  let side = alert === "LONG_ENTRY" ? "buy" :
             alert === "SHORT_ENTRY" ? "sell" : "";

  if (side === "") return res.status(400).send("No trade action");

  try {
    console.log(`📈 Sending ${side.toUpperCase()} order for ${symbol} (${units || 1000} units)...`);

    const response = await fetch(`${OANDA_API_URL}/accounts/${ACCOUNT_ID}/orders`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        order: {
          instrument: symbol,
          units: side === "buy" ? (units || 1000) : -(units || 1000),
          type: "MARKET",
          positionFill: "DEFAULT"
        }
      })
    });

    const result = await response.json();
    console.log("📦 Order result:", result);
    res.send("✅ Order executed");
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).send("Error executing order");
  }
});

// ===== Railway用ポート設定 =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
