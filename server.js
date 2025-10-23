import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ✅ Railway が指定するポートを使用
const PORT = process.env.PORT || 8080;

// ✅ 動作確認用（ブラウザで「Cannot GET /」を防ぐ）
app.get("/", (req, res) => {
  res.send("OANDA Auto Trading Bot is running 🚀");
});

// ✅ Webhook受信エンドポイント
app.post("/webhook", async (req, res) => {
  try {
    const data = req.body;
    console.log("Received alert:", data);

    // 環境変数からOANDA認証情報を取得
    const OANDA_API_KEY = process.env.OANDA_API_KEY;
    const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
    const OANDA_API_URL = "https://api-fxpractice.oanda.com/v3/accounts";

    // ロット指定（ユニット数）
    const units = data.alert.includes("LONG") ? 20000 : -20000;

    if (data.alert === "LONG_ENTRY" || data.alert === "SHORT_ENTRY") {
      const order = {
        order: {
          instrument: data.symbol,
          units,
          type: "MARKET",
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
      console.log("OANDA Response:", result);
      res.status(200).send("Order sent to OANDA ✅");
    } else {
      res.status(200).send("No trade executed.");
    }

  } catch (err) {
    console.error("Error:", err);
    res.status(500).send("Server Error");
  }
});

// ✅ サーバー起動
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
