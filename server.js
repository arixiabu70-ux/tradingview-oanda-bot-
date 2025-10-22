import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// OANDA設定
const OANDA_API = "https://api-fxpractice.oanda.com/v3";
const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const API_KEY = process.env.OANDA_API_KEY;

app.post("/webhook", async (req, res) => {
  const signal = req.body.message;
  console.log("Received signal:", signal);

  let side = "";
  if (signal === "BUY") side = "buy";
  else if (signal === "SELL") side = "sell";
  else return res.status(400).send("Invalid signal");

  try {
    const order = await fetch(`${OANDA_API}/accounts/${ACCOUNT_ID}/orders`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        order: {
          instrument: "USD_JPY",
          units: side === "buy" ? 1000 : -1000,
          type: "MARKET",
          positionFill: "DEFAULT"
        }
      })
    });

    const data = await order.json();
    console.log("Order result:", data);
    res.send("Order executed");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error executing order");
  }
});

app.listen(8080, () => console.log("🚀 Server running on port 8080"));
