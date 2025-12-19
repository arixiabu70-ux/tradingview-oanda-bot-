// server.js（OANDA 対応版・TradingView alert() 完全対応・SAFE版）
// Node.js v18+
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

const OANDA_API_URL = "https://api-fxtrade.oanda.com/v3/accounts";

// ===== 設定 =====
const FIXED_UNITS = 20000;
const MIN_SLTP_PIPS = 0.05;
const ORDER_COOLDOWN_MS = 60 * 1000;
const EXIT_GRACE_MS = 500;
const EPS = 0.005;

const PRECISION_MAP = {
  USD_JPY: 3,
  EUR_USD: 5
};

// ===== 状態管理 =====
let lastOrderTime = {};
let lastExitTime  = {};

// =======================================================
// ヘルパー
// =======================================================
function fmtPrice(price, symbol = "USD_JPY") {
  const decimals = PRECISION_MAP[symbol] ?? 3;
  const n = Number(price);
  if (!isFinite(n)) return null;
  return n.toFixed(decimals);
}

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  console.log(`📥 HTTP ${res.status} ${url}`);
  console.log("📥 Body:", text);
  if (!res.ok) throw new Error(text);
  return JSON.parse(text);
}

async function fetchWithRetry(url, options = {}, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchJSON(url, options);
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function getCurrentMidPrice(symbol) {
  const url = `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/pricing?instruments=${symbol}`;
  const data = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${OANDA_API_KEY}` }
  });
  const p = data.prices[0];
  return (Number(p.closeoutBid) + Number(p.closeoutAsk)) / 2;
}

function isTooClose(a, b, min) {
  return Math.abs(Number(a) - Number(b)) < min;
}

async function getOpenPosition(symbol) {
  const url = `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/openPositions`;
  const data = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${OANDA_API_KEY}` }
  });
  return (data.positions || []).find(p => p.instrument === symbol) || null;
}

async function getPendingOrders(symbol) {
  const url = `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders`;
  const data = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${OANDA_API_KEY}` }
  });
  return (data.orders || []).filter(o => o.instrument === symbol);
}

async function cancelAllPendingOrders(symbol) {
  const orders = await getPendingOrders(symbol);
  for (const o of orders) {
    await fetch(
      `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders/${o.id}/cancel`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${OANDA_API_KEY}` }
      }
    );
  }
}

async function closePositionAll(symbol) {
  await cancelAllPendingOrders(symbol);

  const pos = await getOpenPosition(symbol);
  if (!pos) return;

  const body = {};
  if (Number(pos.long.units) > 0) body.longUnits = "ALL";
  if (Number(pos.short.units) < 0) body.shortUnits = "ALL";

  await fetch(
    `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/positions/${symbol}/close`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${OANDA_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
}

// =======================================================
// ★ 追加：LIMIT 注文発行（500の根本原因を修正）
// =======================================================
async function placePendingOrder(symbol, units, entry, sl, tp, type = "LIMIT") {
  const body = {
    order: {
      type,
      instrument: symbol,
      units: units.toString(),
      price: fmtPrice(entry, symbol),
      timeInForce: "GTC",
      positionFill: "DEFAULT"
    }
  };

  if (sl != null) {
    body.order.stopLossOnFill = { price: fmtPrice(sl, symbol) };
  }
  if (tp != null) {
    body.order.takeProfitOnFill = { price: fmtPrice(tp, symbol) };
  }

  console.log("📤 PLACE ORDER:", JSON.stringify(body));

  return await fetchWithRetry(
    `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OANDA_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
}

// =======================================================
// 🔥 TradingView Webhook
// =======================================================
app.post("/webhook", async (req, res) => {
  try {
    console.log("📬 RAW:", req.body);

    let payload = req.body;
    if (typeof req.body.alert_message === "string") {
      payload = JSON.parse(req.body.alert_message);
    }

    console.log("📬 PARSED:", payload);

    const { alert, symbol, entryPrice, stopLossPrice, takeProfitPrice } = payload;
    if (!alert || !symbol) {
      return res.status(400).json({ error: "invalid payload" });
    }

    const now = Date.now();

    // ===== EXIT =====
    if (alert === "EXIT") {
      console.log("🚪 EXIT received");
      lastExitTime[symbol] = now;
      lastOrderTime[symbol] = 0;
      await closePositionAll(symbol);
      return res.json({ ok: true, action: "exit" });
    }

    // ===== ENTRY ガード =====
    if (now - (lastExitTime[symbol] || 0) < EXIT_GRACE_MS) {
      return res.json({ ok: true, skipped: "just exited" });
    }

    if (!["LONG_LIMIT", "SHORT_LIMIT"].includes(alert)) {
      return res.status(400).json({ error: "unknown alert type" });
    }

    if (now - (lastOrderTime[symbol] || 0) < ORDER_COOLDOWN_MS) {
      return res.json({ ok: true, skipped: "cooldown" });
    }

    const units = alert === "LONG_LIMIT" ? FIXED_UNITS : -FIXED_UNITS;

    const entry = Number(entryPrice);
    const sl = stopLossPrice != null ? Number(stopLossPrice) : null;
    const tp = takeProfitPrice != null ? Number(takeProfitPrice) : null;

    const market = await getCurrentMidPrice(symbol);
    if (isTooClose(market, entry, MIN_SLTP_PIPS)) {
      return res.status(400).json({ error: "entry too close" });
    }

    const pending = await getPendingOrders(symbol);
    if (pending.some(o => Math.abs(Number(o.price) - entry) < EPS)) {
      return res.json({ ok: true, skipped: "duplicate" });
    }

    await placePendingOrder(symbol, units, entry, sl, tp, "LIMIT");
    lastOrderTime[symbol] = now;

    console.log("✅ LIMIT order placed");
    return res.json({ ok: true });

  } catch (err) {
    console.error("❌ webhook error:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});
