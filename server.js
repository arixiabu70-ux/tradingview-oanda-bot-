// server.js（Zone + RR AutoTrade SAFE v3 対応）
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const { OANDA_ACCOUNT_ID, OANDA_API_KEY } = process.env;

if (!OANDA_ACCOUNT_ID || !OANDA_API_KEY) {
  console.error("❌ OANDA_ACCOUNT_ID or OANDA_API_KEY missing");
  process.exit(1);
}

const OANDA_API_URL = "https://api-fxtrade.oanda.com/v3/accounts";
const FIXED_UNITS = 20000;

// ===== クールダウン =====
const ORDER_COOLDOWN_MS = 30_000;
const EXIT_COOLDOWN_MS  = 3_000;

// ===== 価格桁 =====
const PRECISION_MAP = {
  USD_JPY: 3,
  EUR_USD: 5
};

let lastOrderTime = {};
let lastEntryTime = {};

const fmtPrice = (p, s="USD_JPY") =>
  Number(p).toFixed(PRECISION_MAP[s] ?? 3);

// ===== 認証 =====
const auth = {
  Authorization: `Bearer ${OANDA_API_KEY}`,
  "Content-Type": "application/json"
};

// ======================
// 共通 fetch（401耐性）
// ======================
async function fetchJSON(url, options={}) {
  const res = await fetch(url, options);
  const text = await res.text();

  console.log(`📡 ${options.method || "GET"} ${url}`);
  console.log(`📥 [${res.status}] ${text}`);

  if (!res.ok) {
    return { error: true, status: res.status, body: text };
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// ======================
// OANDA操作（GET禁止）
// ======================
async function closePosition(symbol) {
  console.log(`🔴 CLOSE ALL: ${symbol}`);

  return fetchJSON(
    `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/positions/${symbol}/close`,
    {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        longUnits: "ALL",
        shortUnits: "ALL"
      })
    }
  );
}

async function placeLimit(symbol, units, entry, sl, tp) {
  const body = {
    order: {
      type: "LIMIT",
      instrument: symbol,
      units: units.toString(),
      price: fmtPrice(entry, symbol),
      timeInForce: "GTC",
      positionFill: "DEFAULT",
      stopLossOnFill: sl ? { price: fmtPrice(sl, symbol) } : undefined,
      takeProfitOnFill: tp ? { price: fmtPrice(tp, symbol) } : undefined
    }
  };

  console.log("📤 LIMIT ORDER:", JSON.stringify(body));

  return fetchJSON(
    `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders`,
    {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body)
    }
  );
}

// ======================
// Webhook
// ======================
app.post("/webhook", async (req, res) => {
  try {
    const payload = req.body.alert_message
      ? JSON.parse(req.body.alert_message)
      : req.body;

    console.log("📬 WEBHOOK:", payload);

    const {
      alert,
      symbol,
      entryPrice,
      stopLossPrice,
      takeProfitPrice
    } = payload;

    const now = Date.now();

    // ===== EXIT（ゾーン切替）=====
    if (alert === "EXIT") {
      if (now - (lastEntryTime[symbol] ?? 0) < EXIT_COOLDOWN_MS) {
        console.log("⏳ EXIT ignored (cooldown)");
        return res.json({ skipped: "exit cooldown" });
      }

      await closePosition(symbol);
      return res.json({ ok: true });
    }

    // ===== ENTRY =====
    if (now - (lastOrderTime[symbol] ?? 0) < ORDER_COOLDOWN_MS) {
      return res.json({ skipped: "order cooldown" });
    }

    const units =
      alert === "LONG_LIMIT"  ?  FIXED_UNITS :
      alert === "SHORT_LIMIT" ? -FIXED_UNITS : 0;

    if (!units) {
      return res.json({ skipped: "unknown alert" });
    }

    // 念のため全決済（ゾーン戦略用）
    await closePosition(symbol);

    await placeLimit(
      symbol,
      units,
      Number(entryPrice),
      Number(stopLossPrice),
      Number(takeProfitPrice)
    );

    lastOrderTime[symbol] = now;
    lastEntryTime[symbol] = now;

    return res.json({ ok: true });

  } catch (e) {
    console.error("❌ WEBHOOK ERROR:", e.message);
    return res.json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Zone + RR AutoTrade SAFE BOT running on ${PORT}`);
});
