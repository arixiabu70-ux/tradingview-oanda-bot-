// server.js（OANDA STOP注文対応版・改善版）
// Node.js v18+ 推奨
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
const FIXED_UNITS = 20000;
const MIN_SLTP_PIPS = 0.01; // SL/TPの最小距離
const ORDER_COOLDOWN_MS = 60 * 1000; // 1分
const EPS = 0.0001; // STOP注文重複判定の誤差

// シンボル・方向別クールダウン管理
let lastOrderTime = {}; // { 'USD_JPY_LONG': timestamp, 'USD_JPY_SHORT': timestamp }

// シンボル別小数点精度
const PRECISION_MAP = { "USD_JPY": 3, "EUR_USD": 5 };

// ===== ヘルパー =====
function fmtPrice(price, symbol = "USD_JPY") {
  if (price === null || price === undefined) return null;
  const decimals = PRECISION_MAP[symbol] || 3;
  const n = Number(price);
  return Number.isNaN(n) ? null : n.toFixed(decimals);
}

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text}`);
  }
}

async function fetchWithRetry(url, options = {}, retries = 3, delay = 1000) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchJSON(url, options);
    } catch (err) {
      if (i === retries) throw err;
      console.log(`⚠️ fetch retry ${i + 1}: ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function getOpenPositionForInstrument(instrument) {
  const url = `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/openPositions`;
  const data = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${OANDA_API_KEY}` } });
  return (data.positions || []).find(p => p.instrument === instrument) || null;
}

async function getPendingOrders(instrument) {
  const url = `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders`;
  const data = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${OANDA_API_KEY}` } });
  return (data.orders || []).filter(o => o.instrument === instrument);
}

// ===== STOP 注文作成 =====
async function placeStopOrder(instrument, units, entryPrice, stopLossPrice = null, takeProfitPrice = null) {
  const order = {
    order: {
      type: "STOP",
      instrument,
      units: String(units),
      price: fmtPrice(entryPrice, instrument),
      timeInForce: "GTC",
      positionFill: "DEFAULT",
    }
  };

  if (stopLossPrice) order.order.stopLossOnFill = { price: fmtPrice(stopLossPrice, instrument), timeInForce: "GTC" };
  if (takeProfitPrice) order.order.takeProfitOnFill = { price: fmtPrice(takeProfitPrice, instrument), timeInForce: "GTC" };

  const url = `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders`;
  console.log("📤 STOP注文送信:", JSON.stringify(order, null, 2));
  return await fetchWithRetry(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${OANDA_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(order),
  });
}

// ===== 決済（既存） =====
async function closePositionAll(instrument) {
  const url = `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/positions/${instrument}/close`;
  const pos = await getOpenPositionForInstrument(instrument);
  if (!pos) {
    console.log("ℹ️ 決済対象ポジションなし");
    return { ok: false, message: "no position" };
  }

  const longUnits = parseFloat(pos.long?.units || 0);
  const shortUnits = parseFloat(pos.short?.units || 0);
  const body = {};
  if (longUnits > 0) body.longUnits = "ALL";
  if (shortUnits < 0) body.shortUnits = "ALL";

  console.log("📤 決済リクエスト送信:", url, body);

  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${OANDA_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log("📨 OANDA決済レスポンス:", text);
    if (!res.ok) return { error: true, status: res.status, text };
    return JSON.parse(text);
  } catch (err) {
    console.error("❌ 決済通信エラー:", err);
    return { error: true, exception: String(err) };
  }
}

// ===== Webhook エンドポイント =====
app.post("/webhook", async (req, res) => {
  try {
    console.log("📬 Webhook受信:", JSON.stringify(req.body, null, 2));
    const { alert, orderType, symbol, entryPrice, stopLossPrice, takeProfitPrice } = req.body;
    if (!alert || !symbol) return res.status(400).json({ ok: false, message: "invalid payload" });

    // EXIT / CLOSE_ALL
    if (alert.includes("EXIT") || alert === "CLOSE_ALL") {
      console.log("🔶 EXITシグナル受信: ポジション全決済");
      const closeResult = await closePositionAll(symbol);
      return res.status(200).json({ ok: true, action: "closed", result: closeResult });
    }

    const side = alert.includes("LONG") ? "LONG" : alert.includes("SHORT") ? "SHORT" : null;
    if (!side) return res.status(400).json({ ok: false, message: "unknown alert side" });

    const key = `${symbol}_${side}`;
    const now = Date.now();
    if (now - (lastOrderTime[key] || 0) < ORDER_COOLDOWN_MS) {
      console.log(`⚠️ ${key} order skipped due to cooldown`);
      return res.status(200).json({ ok: true, message: "cooldown" });
    }

    // 既存ポジションチェック
    const pos = await getOpenPositionForInstrument(symbol);
    const longUnits = pos ? parseFloat(pos.long?.units || 0) : 0;
    const shortUnits = pos ? parseFloat(pos.short?.units || 0) : 0;
    const netUnits = longUnits - shortUnits;
    const wantUnits = side === "LONG" ? FIXED_UNITS : -FIXED_UNITS;

    if ((side === "LONG" && netUnits > 0) || (side === "SHORT" && netUnits < 0)) {
      console.log(`⚠️ ${key} position already exists.`);
      return res.status(200).json({ ok: true, message: "position exists" });
    }

    const sl = stopLossPrice ? Number(stopLossPrice) : null;
    const tp = takeProfitPrice ? Number(takeProfitPrice) : null;

    if (orderType && orderType.toUpperCase() === "STOP") {
      // 重複STOP注文チェック（EPS許容）
      const pending = await getPendingOrders(symbol);
      const sameOrder = pending.find(o => {
        return o.type === "STOP" &&
               Math.abs(Number(o.price) - Number(entryPrice)) < EPS &&
               ((side === "LONG" && Number(o.units) > 0) || (side === "SHORT" && Number(o.units) < 0));
      });
      if (sameOrder) {
        console.log("⚠️ 同一の保留 STOP 注文が既に存在するためスキップ:", sameOrder.id);
        return res.status(200).json({ ok: true, message: "duplicate pending order" });
      }

      console.log(`📤 STOP注文: ${key}, units=${wantUnits}, ENTRY=${entryPrice}, SL=${sl}, TP=${tp}`);
      const placeResult = await placeStopOrder(symbol, wantUnits, entryPrice, sl, tp);
      lastOrderTime[key] = now;

      return res.status(200).json({
        ok: true,
        action: "stop_order_created",
        side,
        requestedEntry: fmtPrice(entryPrice, symbol),
        requestedSL: sl ? fmtPrice(sl, symbol) : null,
        requestedTP: tp ? fmtPrice(tp, symbol) : null,
        raw: placeResult,
      });
    }

    return res.status(200).json({ ok: false, message: "no action taken (no valid orderType)" });

  } catch (err) {
    console.error("❌ /webhook error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
