import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// 環境変数の安全参照
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID || "";
const OANDA_API_KEY = process.env.OANDA_API_KEY || "";
const OANDA_API_URL = "https://api-fxtrade.oanda.com/v3/accounts";

console.log("OANDA_ACCOUNT_ID:", OANDA_ACCOUNT_ID ? "SET ✅" : "NOT SET ❌");
console.log("OANDA_API_KEY:", OANDA_API_KEY ? "SET ✅" : "NOT SET ❌");

// 以下 webhook 処理やエントリー処理はそのまま
