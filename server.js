import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ====== OANDA設定 ======
const OANDA_API_URL = "https://api-fxtrade.oanda.com/v3"; // 本番環境
const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const API_KEY = process.env.OANDA_API_KEY;

const log = (...args) => console.log(new Date().toISOString(), "-", ...args);

// ====== 注文関数 ======
async function sendOrder(symbol, side, units, entryPrice, sl, tp) {
  const orderBody = {
    order: {
      instrument: symbol,
      units: side === "buy" ? units : -units,
      type: "MARKET",
      positionFill: "DEFAULT",
      stopLossOnFill: sl ? { price: sl.toFixed(3) } : undefined,
      takeProfitOnFill: tp ? { price: tp.toFixed(3) } : undefined,
    },
  };

  const res = await fetch(`${OANDA_API}/accounts/${ACCOUNT_ID}/orders`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(orderBody),
  });

  const data = await res.json();
  log("Order result:", data);
  return data;
}

// ====== 決済関数 ======
async function closeAll(symbol) {
  const res = await fetch(`${OANDA_API}/accounts/${ACCOUNT_ID}/positions/${symbol}/close`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      longUnits: "ALL",
      shortUnits: "ALL",
    }),
  });

  const data = await res.json();
  log("Close result:", data);
  return data;
}

// ====== Webhookエンドポイント ======
app.post("/webhook", async (req, res) => {
  const alert = req.body.alert;
  const symbol = req.body.symbol || "USD_JPY";
  const entryPrice = Number(req.body.entryPrice);
  const stopLossPrice = Number(req.body.stopLossPrice);
  const takeProfitPrice = Number(req.body.takeProfitPrice);

  log("📩 Received signal:", alert, symbol, entryPrice, stopLossPrice, takeProfitPrice);

  if (!alert) return res.status(400).send("Missing alert type");

  try {
    let result;

    switch (alert) {
      case "LONG_ENTRY":
        log("🟢 LONG ENTRY signal received");
        result = await sendOrder(symbol, "buy", 1000, entryPrice, stopLossPrice, takeProfitPrice);
        break;

      case "SHORT_ENTRY":
        log("🔴 SHORT ENTRY signal received");
        result = await sendOrder(symbol, "sell", 1000, entryPrice, stopLossPrice, takeProfitPrice);
        break;

      case "LONG_EXIT_ZLSMA":
      case "SHORT_EXIT_ZLSMA":
        log("⚪ EXIT signal received (ZLSMA cross)");
        result = await closeAll(symbol);
        break;

      default:
        log("⚠️ Unknown alert type:", alert);
        return res.status(400).send("Unknown alert type");
    }

    res.status(200).send(`✅ Executed: ${alert}`);
  } catch (err) {
    log("❌ Error executing order:", err);
    res.status(500).send("Error executing order");
  }
});

// ====== サーバー起動 ======
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => log(`🚀 Server running on port ${PORT}`));
