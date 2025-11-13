// server.js（OANDA決済安定版・midPrice対応・ユニット20000・RR1:2）
// Node.js v18+ 推奨
// 環境変数: OANDA_ACCOUNT_ID, OANDA_API_KEY を設定してください

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
const PRECISION = 3;
const MIN_SLTP_PIPS = 0.01; // SL/TPの最小距離
const ORDER_COOLDOWN_MS = 60 * 1000; // 1分

let lastOrderTime = { LONG: 0, SHORT: 0 };

// ===== ヘルパー関数 =====
function fmtPrice(price, decimals = PRECISION) {
  if (price === null || price === undefined) return null;
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

async function getOpenPositionForInstrument(instrument) {
  const url = `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/openPositions`;
  const data = await fetchJSON(url, { headers: { Authorization: `Bearer ${OANDA_API_KEY}` } });
  return (data.positions || []).find(p => p.instrument === instrument) || null;
}

// ✅ 決済安定版：実際に持っている方向のみクローズ
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

async function placeMarketOrder(instrument, units, stopLossPrice = null, takeProfitPrice = null) {
  const order = {
    order: {
      instrument,
      units: String(units),
      type: "MARKET",
      positionFill: "REDUCE_FIRST",
    },
  };

  // SL/TP最小幅補正
  if (stopLossPrice && takeProfitPrice) {
    if (Math.abs(takeProfitPrice - stopLossPrice) < MIN_SLTP_PIPS) {
      takeProfitPrice = stopLossPrice + MIN_SLTP_PIPS;
    }
  }

  if (stopLossPrice) order.order.stopLossOnFill = { price: fmtPrice(stopLossPrice), timeInForce: "GTC" };
  if (takeProfitPrice) order.order.takeProfitOnFill = { price: fmtPrice(takeProfitPrice), timeInForce: "GTC" };

  const url = `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders`;
  return await fetchJSON(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${OANDA_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(order),
  });
}

// ===== Webhookエンドポイント =====
app.post("/webhook", async (req, res) => {
  try {
    console.log("📬 Webhook受信:", JSON.stringify(req.body, null, 2));

    const { alert, symbol, entryPrice, stopLossPrice, takeProfitPrice } = req.body;
    if (!alert || !symbol) return res.status(400).json({ ok: false, message: "invalid payload" });
    if (symbol !== "USD_JPY") return res.status(400).json({ ok: false, message: "unsupported symbol" });

    // === EXIT or CLOSE_ALL ===
    if (alert.includes("EXIT") || alert === "CLOSE_ALL") {
      console.log("🔶 EXITシグナル受信: ポジション全決済");
      const closeResult = await closePositionAll(symbol);
      return res.status(200).json({ ok: true, action: "closed", result: closeResult });
    }

    // === LONG or SHORT エントリー ===
    const side = alert.includes("LONG") ? "LONG" : alert.includes("SHORT") ? "SHORT" : null;
    if (!side) return res.status(400).json({ ok: false, message: "unknown alert side" });

    const now = Date.now();
    if (now - (lastOrderTime[side] || 0) < ORDER_COOLDOWN_MS) {
      console.log(`⚠️ ${side} order skipped due to cooldown`);
      return res.status(200).json({ ok: true, message: "cooldown" });
    }

    const pos = await getOpenPositionForInstrument(symbol);
    const longUnits = pos ? parseFloat(pos.long?.units || 0) : 0;
    const shortUnits = pos ? parseFloat(pos.short?.units || 0) : 0;
    const netUnits = longUnits - shortUnits;
    const wantUnits = side === "LONG" ? FIXED_UNITS : -FIXED_UNITS;

    if ((side === "LONG" && netUnits > 0) || (side === "SHORT" && netUnits < 0)) {
      console.log(`⚠️ ${side} position already exists.`);
      return res.status(200).json({ ok: true, message: "position exists" });
    }

    const sl = stopLossPrice ? Number(stopLossPrice) : null;
    const tp = takeProfitPrice ? Number(takeProfitPrice) : null;

    console.log(`📤 MARKET注文: ${side}, units=${wantUnits}, SL=${sl}, TP=${tp}`);
    const placeResult = await placeMarketOrder(symbol, wantUnits, sl, tp);

    const fill = placeResult.orderFillTransaction || null;
    const executedPrice = parseFloat(fill?.price || 0);

    lastOrderTime[side] = now;

    return res.status(200).json({
      ok: true,
      action: "order_placed",
      side,
      executedPrice,
      requestedSL: sl ? fmtPrice(sl) : null,
      requestedTP: tp ? fmtPrice(tp) : null,
      raw: placeResult,
    });

  } catch (err) {
    console.error("❌ /webhook error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
