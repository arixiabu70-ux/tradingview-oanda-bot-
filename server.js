// server.js（指値限定・ガード緩和・ログ強化版）
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
const ORDER_COOLDOWN_MS = 30_000; // 連続注文防止（30秒 ）
const EXIT_GRACE_MS = 500;       // 決済後の待機時間

const PRECISION_MAP = {
  USD_JPY: 3,
  EUR_USD: 5
};

let lastOrderTime = {};
let lastExitTime  = {};

const fmtPrice = (p, s="USD_JPY") => Number(p).toFixed(PRECISION_MAP[s] ?? 3);
const auth = { 
  Authorization: `Bearer ${OANDA_API_KEY}`,
  "Content-Type": "application/json"
};

// ログ出力を強化した共通フェッチ関数
async function fetchJSON(url, options={}) {
  const res = await fetch(url, options);
  const text = await res.text();
  
  // すべての通信結果をログに記録
  console.log(`📡 API CALL: ${options.method || 'GET'} ${url}`);
  console.log(`📥 RESPONSE [${res.status}]:`, text);
  
  if (!res.ok) {
    console.error(`❌ OANDA API ERROR: ${res.status} - ${text}`);
    throw new Error(text);
  }
  return JSON.parse(text);
}

async function getOpenPosition(symbol) {
  const d = await fetchJSON(`${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/openPositions`, { headers: auth });
  return d.positions?.find(p => p.instrument === symbol) ?? null;
}

async function cancelAllPendingOrders(symbol) {
  const d = await fetchJSON(`${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders?instrument=${symbol}&state=PENDING`, { headers: auth });
  const orders = d.orders ?? [];
  for (const o of orders) {
    console.log(`🗑️ Cancelling pending order: ${o.id}`);
    await fetchJSON(`${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders/${o.id}/cancel`, { method: "PUT", headers: auth });
  }
}

async function closePositionAll(symbol) {
  // 新しい注文の前に既存の指値をすべて消す
  await cancelAllPendingOrders(symbol);

  const pos = await getOpenPosition(symbol);
  if (!pos) return;

  const body = {};
  if (Number(pos.long.units) > 0) body.longUnits = "ALL";
  if (Number(pos.short.units) < 0) body.shortUnits = "ALL";

  if (Object.keys(body).length > 0) {
    console.log(`Closing position for ${symbol}...`);
    await fetchJSON(`${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/positions/${symbol}/close`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify(body)
    });
  }
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

  return fetchJSON(`${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body)
  });
}

// ======================
// Webhook Endpoint
// ======================
app.post("/webhook", async (req, res) => {
  try {
    const payload = req.body.alert_message ? JSON.parse(req.body.alert_message) : req.body;
    console.log("📬 WEBHOOK RECEIVED:", payload);

    const { alert, symbol, entryPrice, stopLossPrice, takeProfitPrice } = payload;
    const now = Date.now();

    // EXITアラートの処理
    if (alert === "EXIT") {
      lastExitTime[symbol] = now;
      await closePositionAll(symbol);
      return res.json({ ok: true, action: "exit" });
    }

    // ガード処理（時間制限のみ維持）
    if (now - (lastExitTime[symbol] ?? 0) < EXIT_GRACE_MS) {
      return res.json({ skipped: "exit grace period" });
    }
    if (now - (lastOrderTime[symbol] ?? 0) < ORDER_COOLDOWN_MS) {
      return res.json({ skipped: "cooldown period" });
    }

    const units = alert === "LONG_LIMIT" ? FIXED_UNITS : alert === "SHORT_LIMIT" ? -FIXED_UNITS : 0;
    if (!units) return res.json({ skipped: "unknown alert type" });

    // 注文前に既存の状態をクリーンアップ（指値キャンセル & ポジション決済）
    await closePositionAll(symbol);

    // 指値注文の実行
    await placeLimit(
      symbol,
      units,
      Number(entryPrice),
      Number(stopLossPrice),
      Number(takeProfitPrice)
    );

    lastOrderTime[symbol] = now;
    return res.json({ ok: true });

  } catch (e) {
    console.error("❌ WEBHOOK ERROR:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 OANDA SAFE BOT running on port ${PORT}`);
});
