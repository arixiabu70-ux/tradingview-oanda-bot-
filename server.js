// server.js（本番用・指値限定・GET系API完全排除・401回避版）
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

// ---- クールダウン ----
const ORDER_COOLDOWN_MS = 30_000; // 新規エントリー間隔
const EXIT_COOLDOWN_MS  = 3_000;  // ENTRY直後のEXIT無視

// ---- 価格桁 ----
const PRECISION_MAP = {
  USD_JPY: 3,
  EUR_USD: 5
};

let lastOrderTime = {};
let lastEntryTime = {};

const fmtPrice = (p, s="USD_JPY") =>
  Number(p).toFixed(PRECISION_MAP[s] ?? 3);

// ---- 認証 ----
const auth = {
  Authorization: `Bearer ${OANDA_API_KEY}`,
  "Content-Type": "application/json"
};

// ======================
// 共通 fetch（401でも落とさない）
// ======================
async function fetchJSON(url, options={}) {
  const res = await fetch(url, options);
  const text = await res.text();

  console.log(`📡 API CALL: ${options.method || "GET"} ${url}`);
  console.log(`📥 RESPONSE [${res.status}]:`, text);

  if (!res.ok) {
    // webhook を 500 にしない
    return { error: true, status: res.status, body: text };
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// ======================
// OANDA 操作（GET禁止）
// ======================
async function closePosition(symbol) {
  console.log(`🔴 Closing position for ${symbol}`);

  const body = {
    longUnits: "ALL",
    shortUnits: "ALL"
  };

  return fetchJSON(
    `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/positions/${symbol}/close`,
    {
      method: "PUT",
      headers: auth,
      body: JSON.stringify(body)
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

  console.log("📤 SENDING LIMIT ORDER:", JSON.stringify(body));

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

    console.log("📬 WEBHOOK RECEIVED:", payload);

    const { alert, symbol, entryPrice, stopLossPrice, takeProfitPrice } = payload;
    const now = Date.now();

    // ===== EXIT =====
    if (alert === "EXIT") {
      if (now - (lastEntryTime[symbol] ?? 0) < EXIT_COOLDOWN_MS) {
        console.log("⏳ EXIT ignored (entry cooldown)");
        return res.json({ skipped: "entry cooldown" });
      }

      await closePosition(symbol);
      return res.json({ ok: true });
    }

    // ===== ENTRY =====
    if (now - (lastOrderTime[symbol] ?? 0) < ORDER_COOLDOWN_MS) {
      return res.json({ skipped: "order cooldown" });
    }

    const units =
      alert === "LONG_LIMIT"  ? FIXED_UNITS :
      alert === "SHORT_LIMIT" ? -FIXED_UNITS : 0;

    if (!units) {
      return res.json({ skipped: "unknown alert" });
    }

    // 🔥 GET系を使わず、まず全決済
    await closePosition(symbol);

    // 🔥 指値のみ発注
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
    // TradingView に再送させない
    return res.json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 OANDA SAFE BOT running on port ${PORT}`);
});
