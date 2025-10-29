import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 8080;
const { OANDA_ACCOUNT_ID, OANDA_API_KEY } = process.env;

if (!OANDA_ACCOUNT_ID || !OANDA_API_KEY) {
  console.error("❌ OANDA_ACCOUNT_ID or OANDA_API_KEY missing!");
  process.exit(1);
}

const OANDA_API_URL = "https://api-fxtrade.oanda.com/v3/accounts";

app.post("/webhook", async (req, res) => {
  try {
    const { alert, symbol, entryPrice, stopLossPrice, takeProfitPrice } = req.body;
    if (!alert || !symbol) return res.status(400).send("Invalid payload");

    const FIXED_UNITS = 20000;
    const precision = 3;

    // EXIT 一括決済
    if (alert.includes("EXIT")) {
      const posRes = await fetch(`${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/openPositions`, {
        headers: { "Authorization": `Bearer ${OANDA_API_KEY}` }
      });
      const posData = await posRes.json();
      const position = posData.positions?.find(p => p.instrument === symbol);
      if (position) {
        const closeUnits = parseFloat(position.long?.units || 0) - parseFloat(position.short?.units || 0);
        if (closeUnits !== 0) {
          await fetch(`${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${OANDA_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ order: { instrument: symbol, units: -closeUnits, type: "MARKET", positionFill: "DEFAULT" } })
          });
        }
      }
      return res.status(200).send("Position closed ✅");
    }

    // ENTRY
    const side = alert.includes("LONG") ? "buy" : "sell";
    const units = side === "buy" ? FIXED_UNITS : -FIXED_UNITS;
    const order = {
      order: {
        instrument: symbol,
        units: units,
        type: "MARKET",
        stopLossOnFill: { price: parseFloat(stopLossPrice).toFixed(precision) },
        takeProfitOnFill: { price: parseFloat(takeProfitPrice).toFixed(precision) },
        positionFill: "DEFAULT"
      }
    };

    const response = await fetch(`${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${OANDA_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(order)
    });
    const result = await response.json();
    console.log("📈 Order Result:", result);
    res.status(200).send("Order executed ✅");

  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).send("Server error ❌");
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
