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
const FIXED_UNITS = 20000;
const precision = 2; // USD/JPY 専用：小数点2桁
const ORDER_COOLDOWN_MS = 60 * 1000; // 1分間隔

let lastOrderTime = { LONG: 0, SHORT: 0 };

app.post("/webhook", async (req, res) => {
  try {
    const { alert, symbol, entryPrice, stopLossPrice, takeProfitPrice } = req.body;

    if (!alert || symbol !== "USD_JPY") {
      return res.status(400).send("Invalid or unsupported payload");
    }

    // === 現在のポジション取得 ===
    const posRes = await fetch(`${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/openPositions`, {
      headers: { "Authorization": `Bearer ${OANDA_API_KEY}` }
    });
    const posData = await posRes.json();
    const position = posData.positions?.find(p => p.instrument === symbol);

    // === EXIT ===
    if (alert.includes("EXIT")) {
      if (position) {
        const longUnits = parseFloat(position.long?.units || 0);
        const shortUnits = parseFloat(position.short?.units || 0);
        const closeUnits = longUnits - shortUnits;

        if (closeUnits !== 0) {
          await fetch(`${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${OANDA_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              order: {
                instrument: "USD_JPY",
                units: -closeUnits,
                type: "MARKET",
                positionFill: "DEFAULT"
              }
            })
          });
          console.log("✅ 全ポジション決済完了");
        }
      }
      return res.status(200).send("Position closed ✅");
    }

    // === ENTRY ===
    const side = alert.includes("LONG") ? "LONG" : "SHORT";
    const units = side === "LONG" ? FIXED_UNITS : -FIXED_UNITS;
    const now = Date.now();

    // 重複防止：1分間隔チェック
    if (now - lastOrderTime[side] < ORDER_COOLDOWN_MS) {
      console.log(`⚠️ ${side} order skipped (cooldown)`);
      return res.status(200).send("Order skipped (cooldown) ⚠️");
    }

    // 既存ポジション確認
    const longExists = parseFloat(position?.long?.units || 0) > 0;
    const shortExists = parseFloat(position?.short?.units || 0) > 0;
    if ((side === "LONG" && longExists) || (side === "SHORT" && shortExists)) {
      console.log(`⚠️ ${side} position exists. Order skipped.`);
      return res.status(200).send("Order skipped (position exists) ⚠️");
    }

    // === 注文作成 ===
    const sl = stopLossPrice ? Number(parseFloat(stopLossPrice).toFixed(precision)) : null;
    const tp = takeProfitPrice ? Number(parseFloat(takeProfitPrice).toFixed(precision)) : null;

    const order = {
      order: {
        instrument: "USD_JPY",
        units,
        type: "MARKET",
        positionFill: "DEFAULT",
        ...(sl ? { stopLossOnFill: { price: sl, timeInForce: "GTC" } } : {}),
        ...(tp ? { takeProfitOnFill: { price: tp, timeInForce: "GTC" } } : {})
      }
    };

    // === 注文送信 ===
    const response = await fetch(`${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OANDA_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(order)
    });

    const result = await response.json();
    console.log("📈 Order Result:", JSON.stringify(result, null, 2));

    if (result.errorMessage) {
      console.error(`❌ Order error: ${result.errorMessage}`);
      return res.status(400).send(`Order failed ❌ ${result.errorMessage}`);
    }

    lastOrderTime[side] = now;
    return res.status(200).send("Order executed ✅");

  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).send("Server error ❌");
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
