import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// 環境変数を必ず宣言後に参照
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const OANDA_API_KEY = process.env.OANDA_API_KEY;

console.log("OANDA_ACCOUNT_ID:", OANDA_ACCOUNT_ID ? "SET ✅" : "NOT SET ❌");
console.log("OANDA_API_KEY:", OANDA_API_KEY ? "SET ✅" : "NOT SET ❌");

app.get("/", (req, res) => {
  res.send("OANDA Auto Trading Bot is running 🚀");
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
