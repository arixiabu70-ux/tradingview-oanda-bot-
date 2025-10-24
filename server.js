// server.js
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// ===== 環境変数 =====
const { OANDA_ACCOUNT_ID, OANDA_API_KEY } = process.env;

console.log("OANDA_ACCOUNT_ID:", OANDA_ACCOUNT_ID ? "SET ✅" : "NOT SET ❌");
console.log("OANDA_API_KEY:", OANDA_API_KEY ? "SET ✅" : "NOT SET ❌");

if (!OANDA_ACCOUNT_ID || !OANDA_API_KEY) {
  console.error("❌ OANDA_ACCOUNT_ID または OANDA_API_KEY が設定されていません！");
  process.exit(1);
}

// ===== 本番API =====
const OANDA_API_URL = "https://api-fxtrade.oanda.com/v3/accounts";

// ===== GET / =====
app.get("/", (req, res) => {
  res.send("OANDA Auto Trading Bot is running 🚀");
});

// ===== Webhook =====
app.post("/webhook", async (req, res) => {
  try {
    const { alert, symbol, entryPrice, stopLossPrice, takeProfitPrice } = req.body;
    if (!alert || !symbol) return res.status(400).send("Invalid payload");

    const FIXED_UNITS = 20000; // 固定ユニット

    // ===== エントリー処理 =====
    if (alert === "LONG_ENTRY" || alert === "SHORT_ENTRY") {
      const side = alert === "LONG_ENTRY" ? "buy" : "sell";

      const entry = parseFloat(entryPrice.toFixed(2));
      const sl = parseFloat(stopLossPrice.toFixed(2));
      const tp = takeProfitPrice
        ? parseFloat(takeProfitPrice.toFixed(2))
        : side === "buy"
          ? parseFloat((entry + (entry - sl) * 2).toFixed(2))
          : parseFloat((entry - (sl - entry) * 2).toFixed(2));

      const orderUnits = side === "buy" ? FIXED_UNITS : -FIXED_UNITS;

      const order = {
        order: {
          instrument: symbol,
          units: orderUnits,
          type: "MARKET",
          stopLossOnFill: { price: sl.toFixed(2) },
          takeProfitOnFill: { price: tp.toFixed(2) },
          positionFill: "DEFAULT"
        }
      };

      const response = await fetch(`${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OANDA_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(order)
      });

      const result = await response.json();
      console.log("Order result:", result);
      return res.status(200).send("Order executed ✅");
    }

    // ===== ZLSMAクロス決済 =====
    if (alert === "LONG_EXIT_ZLSMA" || alert === "SHORT_EXIT_ZLSMA") {
      const posRes = await fetch(`${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/openPositions`, {
        headers: { "Authorization": `Bearer ${OANDA_API_KEY}` }
      });
      const posData = await posRes.json();
      console.log("Open positions:", posData);

      if (!posData.positions || posData.positions.length === 0)
        return res.status(200).send("No open positions");

      const position = posData.positions.find(p => p.instrument === symbol);
      if (!position) return res.status(200).send("No open position for this instrument");

      const closeUnits = alert === "LONG_EXIT_ZLSMA"
        ? -parseFloat(position.long?.units || 0)
        : -parseFloat(position.short?.units || 0);

      if (closeUnits === 0) return res.status(200).send("No units to close");

      const closeOrder = {
        order: {
          instrument: symbol,
          units: closeUnits,
          type: "MARKET",
          positionFill: "DEFAULT"
        }
      };

      const closeRes = await fetch(`${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OANDA_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(closeOrder)
      });

      const closeResult = await closeRes.json();
      console.log("Close result:", closeResult);
      return res.status(200).send("Position closed ✅");
    }

    return res.status(200).send("No action executed");
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).send("Server error ❌");
  }
});

// ===== サーバー起動 =====
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
