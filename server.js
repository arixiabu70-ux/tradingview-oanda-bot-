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

// === キャッシュ：直近の注文時刻（ミリ秒） ===
let lastOrderTime = {
  LONG: 0,
  SHORT: 0
};
const ORDER_COOLDOWN_MS = 60 * 1000; // 1分間隔

app.post("/webhook", async (req, res) => {
  try {
    const { alert, symbol, entryPrice, stopLossPrice, takeProfitPrice } = req.body;
    if (!alert || !symbol) return res.status(400).send("Invalid payload");

    const FIXED_UNITS = 20000;
    const precision = 3; // USD/JPY用

    // 現在ポジション取得
    const posRes = await fetch(`${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/openPositions`, {
      headers: { "Authorization": `Bearer ${OANDA_API_KEY}` }
    });
    const posData = await posRes.json();
    const position = posData.positions?.find(p => p.instrument === symbol);

    // === EXIT 一括決済 ===
    if (alert.includes("EXIT")) {
      if (position) {
        const longUnits = parseFloat(position.long?.units || 0);
        const shortUnits = parseFloat(position.short?.units || 0);
        const closeUnits = longUnits - shortUnits;
        if (closeUnits !== 0) {
          await fetch(`${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${OANDA_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              order: {
                instrument: symbol,
                units: -closeUnits,
                type: "MARKET",
                positionFill: "DEFAULT"
              }
            })
          });
        }
      }
      return res.status(200).send("Position closed ✅");
    }

    // === ENTRY（重複防止 + 1分間隔制御） ===
    const side = alert.includes("LONG") ? "LONG" : "SHORT";
    const units = side === "LONG" ? FIXED_UNITS : -FIXED_UNITS;
    const now = Date.now();

    // 同方向ポジション存在チェック
    const longExists = parseFloat(position?.long?.units || 0) > 0;
    const shortExists = parseFloat(position?.short?.units || 0) > 0;

    if ((side === "LONG" && !longExists) || (side === "SHORT" && !shortExists)) {
      // 直近注文から1分以内ならスキップ
      if (now - lastOrderTime[side] < ORDER_COOLDOWN_MS) {
        console.log(`⚠️ ${side} order skipped (cooldown)`);
        return res.status(200).send(`Order skipped (cooldown) ⚠️`);
      }

      // 注文実行
      const order = {
        order: {
          instrument: symbol,
          units: units,
          type: "MARKET",
          stopLossOnFill: { price: Number(parseFloat(stopLossPrice).toFixed(precision)) },
          takeProfitOnFill: { price: Number(parseFloat(takeProfitPrice).toFixed(precision)) },
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

      // 注文時刻更新
      lastOrderTime[side] = now;
      return res.status(200).send("Order executed ✅");
    } else {
      console.log(`⚠️ ${side} position exists. Order skipped.`);
      return res.status(200).send("Order skipped (position exists) ⚠️");
    }

  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).send("Server error ❌");
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
