// server.js（指値限定・EXIT耐性強化・安全版）
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

const ORDER_COOLDOWN_MS = 30_000; // 新規エントリー間隔
const EXIT_COOLDOWN_MS  = 3_000;  // ENTRY直後のEXIT無視

const PRECISION_MAP = {
  USD_JPY: 3,
  EUR_USD: 5
};

let lastOrderTime = {};
let lastEntryTime = {};

const fmtPrice = (p, s="USD_JPY") =>
  Number(p).toFixed(PRECISION_MAP[s] ?? 3);

const auth = {
  Authorization: `Bearer ${OANDA_API_KEY}`,
  "Content-Type": "application/json"
};

// ======================
// 共通 fetch
// ======================
async function fetchJSON(url, options={}) {
  const res = await fetch(url, options);
  const text = await res.text();

  console.log(`📡 API CALL: ${options.method || "GET"} ${url}`);
  console.log(`📥 RESPONSE [${res.status}]:`, text);

  if (!res.ok) {
    throw new Error(text);
  }
  return JSON.parse(text);
}

// ======================
// OANDA helpers
// ======================
async function getOpenPosition(symbol) {
  const d = await fetchJSON(
    `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/openPositions`,
    { headers: auth }
  );
  return d.positions?.find(p => p.instrument === symbol) ?? null;
}

async function cancelPendingOrders(symbol) {
  const d = await fetchJSON(
    `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders?instrument=${symbol}&state=PENDING`,
    { headers: auth }
  );
  for (const o of d.orders ?? []) {
    console.log(`🗑️ Cancelling pending order: ${o.id}`);
    await fetchJSON(
      `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders/${o.id}/cancel`,
      { method: "PUT", headers: auth }
    );
  }
}

async function closePosition(symbol) {
  const pos = await getOpenPosition(symbol);
  if (!pos) {
    console.log("ℹ No position to close");
    return false;
  }

  const body = {};
  if (Number(pos.long.units) > 0) body.longUnits = "ALL";
  if (Number(pos.short.units) < 0) body.shortUnits = "ALL";

  console.log(`🔴 Closing position for ${symbol}`);
  await fetchJSON(
    `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/positions/${symbol}/close`,
    {
      method: "PUT",
      headers: auth,
      body: JSON.stringify(body)
    }
  );
  return true;
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
    { method: "POST", headers: auth, body: JSON.stringify(body) }
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
      // ENTRY直後のEXIT無視
      if (now - (lastEntryTime[symbol] ?? 0) < EXIT_COOLDOWN_MS) {
        console.log("⏳ EXIT ignored (entry cooldown)");
        return res.json({ skipped: "entry cooldown" });
      }

      const closed = await closePosition(symbol);
      return res.json({ ok: true, closed });
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

    // 新規エントリー時のみクリーンアップ
    await cancelPendingOrders(symbol);
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
    return res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 OANDA SAFE BOT running on port ${PORT}`);
});
