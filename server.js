// server.js
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const { OANDA_ACCOUNT_ID, OANDA_API_KEY } = process.env;

if (!OANDA_ACCOUNT_ID || !OANDA_API_KEY) {
  console.error("❌ OANDA_ACCOUNT_ID または OANDA_API_KEY が設定されていません！");
  process.exit(1);
}

// デモ環境の場合はこちらを使用:
// const OANDA_API_URL = "https://api-fxpractice.oanda.com/v3/accounts";
const OANDA_API_URL = "https://api-fxtrade.oanda.com/v3/accounts";

// ===== 通貨ペアごとの小数点桁数判定 =====
function getPrecision(symbol) {
  return symbol.includes("JPY") ? 3 : 5;
}

// ===== TradingView形式 → OANDA形式変換 =====
function formatSymbol(rawSymbol) {
  if (!rawSymbol) return "";
  return rawSymbol.replace(/^.*:/, "").replace(/([A-Z]{3})([A-Z]{3})/, "$1_$2");
}

app.get("/", (req, res) => {
  res.send("OANDA Auto Trading Bot is running 🚀");
});

app.post("/webhook", async (req, res) => {
  try {
    const { alert, symbol: rawSymbol, entryPrice, stopLossPrice, takeProfitPrice } = req.body;
    if (!alert || !rawSymbol) return res.status(400).send("Invalid payload");

    // 🔧 通貨ペア変換
    const symbol = formatSymbol(rawSymbol);
    const precision = getPrecision(symbol);
    const FIXED_UNITS = 20000;

    console.log(`📩 Webhook受信: ${alert} (${symbol})`);

    // ===== エントリー処理 =====
    if (alert === "LONG_ENTRY" || alert === "SHORT_ENTRY") {
      const side = alert === "LONG_ENTRY" ? "buy" : "sell";
      const entry = parseFloat(entryPrice);
      let sl = parseFloat(stopLossPrice);
      let tp = parseFloat(takeProfitPrice);

      const orderUnits = side === "buy" ? FIXED_UNITS : -FIXED_UNITS;

      // ===== TP/SLの方向を自動補正 =====
      if (side === "buy") {
        // ロング時：TPは上、SLは下
        if (tp <= entry) {
          const diff = Math.abs(entry - sl) || 0.05;
          tp = entry + diff * 2;
          console.log(`⚠️ ロングTP補正 → ${tp}`);
        }
        if (sl >= entry) {
          sl = entry - Math.abs(tp - entry) / 2;
          console.log(`⚠️ ロングSL補正 → ${sl}`);
        }
      } else {
        // ショート時：TPは下、SLは上
        if (tp >= entry) {
          const diff = Math.abs(sl - entry) || 0.05;
          tp = entry - diff * 2;
          console.log(`⚠️ ショートTP補正 → ${tp}`);
        }
        if (sl <= entry) {
          sl = entry + Math.abs(entry - tp) / 2;
          console.log(`⚠️ ショートSL補正 → ${sl}`);
        }
      }

      const order = {
        order: {
          instrument: symbol,
          units: orderUnits,
          type: "MARKET",
          stopLossOnFill: { price: sl.toFixed(precision) },
          takeProfitOnFill: { price: tp.toFixed(precision) },
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
      console.log("📈 New order result:", result);
      return res.status(200).send("Order executed ✅");
    }

    // ===== ZLSMAクロス決済 =====
    if (alert === "LONG_EXIT_ZLSMA" || alert === "SHORT_EXIT_ZLSMA") {
      const posRes = await fetch(`${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/openPositions`, {
        headers: { "Authorization": `Bearer ${OANDA_API_KEY}` }
      });
      const posData = await posRes.json();
      console.log("📊 Open positions:", posData);

      if (!posData.positions || posData.positions.length === 0)
        return res.status(200).send("No open positions");

      const position = posData.positions.find(p => p.instrument === symbol);
      if (!position) return res.status(200).send("No open position for this symbol");

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
      console.log("🔻 Close result:", closeResult);
      return res.status(200).send("Position closed ✅");
    }

    return res.status(200).send("No action executed");
  } catch (err) {
    console.error("❌ Error:", err);
    return res.status(500).send("Server error ❌");
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
