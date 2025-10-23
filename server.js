import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// ===== 環境変数確認 =====
const OANDA_API_KEY = process.env.OANDA_API_KEY;
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const OANDA_API_URL = "https://api-fxtrade.oanda.com/v3/accounts"; // 本番

console.log("🚀 Starting server...");
console.log("OANDA_ACCOUNT_ID:", OANDA_ACCOUNT_ID ? "SET ✅" : "NOT SET ❌");
console.log("OANDA_API_KEY:", OANDA_API_KEY ? "SET ✅" : "NOT SET ❌");

// ===== GET / でサーバー稼働確認 =====
app.get("/", (req, res) => {
  res.send("OANDA Auto Trading Bot is running 🚀");
});

// ===== Webhook受信 =====
app.post("/webhook", async (req, res) => {
  try {
    const data = req.body;
    console.log("Received alert:", data);

    const { alert, symbol, entryPrice, stopLossPrice, takeProfitPrice, units } = data;

    if (!alert || !symbol) return res.status(400).send("Invalid payload");

    // ===== エントリー処理 =====
    if (alert === "LONG_ENTRY" || alert === "SHORT_ENTRY") {
      if (!OANDA_API_KEY || !OANDA_ACCOUNT_ID) {
        console.error("❌ Environment variables missing!");
        return res.status(500).send("Server error ❌ - Missing env vars");
      }

      const side = alert === "LONG_ENTRY" ? "buy" : "sell";
      const orderUnits = units || (side === "buy" ? 20000 : -20000);

      const SL = stopLossPrice;
      const TP = takeProfitPrice || (side === "buy"
        ? entryPrice + (entryPrice - SL) * 2
        : entryPrice - (SL - entryPrice) * 2);

      const order = {
        order: {
          instrument: symbol,
          units: orderUnits,
          type: "MARKET",
          stopLossOnFill: { price: SL.toFixed(3) },
          takeProfitOnFill: { price: TP.toFixed(3) },
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

    // ===== 決済処理 =====
    if (alert === "LONG_EXIT_ZLSMA" || alert === "SHORT_EXIT_ZLSMA") {
      try {
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

      } catch (err) {
        console.error("Close order error:", err);
        return res.status(500).send("Server error ❌");
      }
    }

    return res.status(200).send("No action executed");
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).send("Server error ❌");
  }
});

// ===== サーバー起動 =====
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
