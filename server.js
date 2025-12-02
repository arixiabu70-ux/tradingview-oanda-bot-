// server.js（OANDA 対応版・改善済み）
// Node.js v18+ 推奨
import express from "express";
import fetch from "node-fetch"; // node 18+ では global fetch があるが、既存コードと互換性のため使用

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
const MIN_SLTP_PIPS = 0.01; // SL/TPの最小距離（通貨単位） - 必要に応じて通貨毎マップ化可能
const ORDER_COOLDOWN_MS = 60 * 1000; // 1分（シンボル単位に変更）
const EPS = 0.002; // 重複STOP/LIMIT 判定の誤差（JPY向けに広めに設定）

// シンボル単位クールダウン管理（キーは symbol のみ）
let lastOrderTime = {}; // { 'USD_JPY': timestamp }

// シンボル別小数点精度
const PRECISION_MAP = { "USD_JPY": 3, "EUR_USD": 5 };

// ===== ヘルパー =====
function fmtPrice(price, symbol = "USD_JPY") {
  if (price === null || price === undefined) return null;
  const decimals = PRECISION_MAP[symbol] || 3;
  const n = Number(price);
  if (Number.isNaN(n)) return null;
  // 小数誤差安定化
  return Number(n.toFixed(decimals)).toFixed(decimals);
}

// fetch + ログ + JSON パース（レスポンスの status と body を常にログ出力）
async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  console.log(`📥 HTTP ${res.status} ${options.method || "GET"} ${url}`);
  console.log("📥 Body:", text);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON from ${url}: ${text}`);
  }
}

// fetch with retry - エラー時は再試行、成功時は fetchJSON を通す
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

// 現在の mid price を取得（pricing endpoint） - 発注前チェック用
async function getCurrentMidPrice(instrument) {
  const url = `https://api-fxtrade.oanda.com/v3/accounts/${OANDA_ACCOUNT_ID}/pricing?instruments=${instrument}`;
  const data = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${OANDA_API_KEY}` } });
  if (!data.prices || data.prices.length === 0) throw new Error("No pricing data");
  const p = data.prices[0];
  const bid = Number(p.closeoutBid);
  const ask = Number(p.closeoutAsk);
  if (!isFinite(bid) || !isFinite(ask)) throw new Error("Invalid pricing bid/ask");
  return (bid + ask) / 2;
}

function isTooClose(marketPrice, targetPrice, minDistance) {
  // number にキャストして比較
  return Math.abs(Number(marketPrice) - Number(targetPrice)) < Number(minDistance);
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

// pending order を全てキャンセル（決済時に使う）
async function cancelAllPendingOrders(instrument) {
  const pending = await getPendingOrders(instrument);
  if (!pending || pending.length === 0) {
    console.log("ℹ️ No pending orders to cancel for", instrument);
    return { cancelled: 0 };
  }
  let cancelled = 0;
  for (const o of pending) {
    try {
      const url = `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders/${o.id}/cancel`;
      console.log("📤 Cancelling order:", o.id, instrument);
      const res = await fetch(url, {
        method: "PUT",
        headers: { Authorization: `Bearer ${OANDA_API_KEY}`, "Content-Type": "application/json" },
      });
      const text = await res.text();
      console.log("📨 Cancel response:", res.status, text);
      if (res.ok) cancelled++;
    } catch (err) {
      console.error("❌ Cancel failed for order", o.id, err);
    }
  }
  return { cancelled };
}

// ===== STOP / LIMIT 注文作成 =====
// type: "STOP" または "LIMIT"
async function placePendingOrder(instrument, units, entryPrice, stopLossPrice = null, takeProfitPrice = null, type = "STOP") {
  const order = {
    order: {
      type: type,
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
  console.log(`📤 ${type} 注文送信:`, JSON.stringify(order, null, 2));

  // 直接 fetch してログを確認できるようにする
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${OANDA_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(order),
  });

  const text = await res.text();
  console.log(`📥 OANDA orders POST status=${res.status}`);
  console.log("📥 OANDA orders POST body:", text);

  if (!res.ok) {
    // エラーメッセージをそのまま投げる（呼び出し元で処理）
    let info = text;
    try { info = JSON.parse(text); } catch {}
    throw new Error(`OANDA order failed: ${res.status} ${JSON.stringify(info)}`);
  }

  return JSON.parse(text);
}

// ===== 決済（既存） =====
async function closePositionAll(instrument) {
  // まず保留注文をキャンセル
  console.log("🔶 closePositionAll: cancelling pending orders for", instrument);
  await cancelAllPendingOrders(instrument);

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
    console.log("📨 OANDA決済レスポンス:", res.status, text);
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
      console.log("🔶 EXITシグナル受信: ポジション全決済 + pending cancel");
      const closeResult = await closePositionAll(symbol);
      return res.status(200).json({ ok: true, action: "closed", result: closeResult });
    }

    // サイド判定（LONG / SHORT） - alert 名で判断
    const side = alert.includes("LONG") ? "LONG" : alert.includes("SHORT") ? "SHORT" : null;
    if (!side) return res.status(400).json({ ok: false, message: "unknown alert side" });

    // クールダウン（シンボル単位）
    const key = `${symbol}`; // symbol単位
    const now = Date.now();
    if (now - (lastOrderTime[key] || 0) < ORDER_COOLDOWN_MS) {
      console.log(`⚠️ ${key} order skipped due to cooldown (since ${lastOrderTime[key]})`);
      return res.status(200).json({ ok: true, message: "cooldown" });
    }

    // 既存ポジションチェック
    const pos = await getOpenPositionForInstrument(symbol);
    const longUnits = pos ? parseFloat(pos.long?.units || 0) : 0;
    const shortUnits = pos ? parseFloat(pos.short?.units || 0) : 0;
    const netUnits = longUnits - shortUnits;
    const wantUnits = side === "LONG" ? FIXED_UNITS : -FIXED_UNITS;

    if ((side === "LONG" && netUnits > 0) || (side === "SHORT" && netUnits < 0)) {
      console.log(`⚠️ ${symbol} position already exists (netUnits=${netUnits}).`);
      return res.status(200).json({ ok: true, message: "position exists" });
    }

    const sl = (stopLossPrice !== undefined && stopLossPrice !== null) ? Number(stopLossPrice) : null;
    const tp = (takeProfitPrice !== undefined && takeProfitPrice !== null) ? Number(takeProfitPrice) : null;
    const entry = Number(entryPrice);

    // 必須チェック: entryPrice が数値か
    if (!isFinite(entry)) {
      console.log("❌ invalid entryPrice:", entryPrice);
      return res.status(400).json({ ok: false, message: "invalid entryPrice" });
    }

    // orderType が与えられないケースもある -> デフォルトは "LIMIT" にして運用する（Pine側で制御できます）
    const ot = (orderType || "LIMIT").toString().toUpperCase();

    // --- 最小距離チェック（現在価格を取得して entry/sl/tp が近すぎないか確認） ---
    try {
      const marketPrice = await getCurrentMidPrice(symbol);
      console.log(`ℹ️ Market mid price for ${symbol}: ${marketPrice}`);

      if (isTooClose(marketPrice, entry, MIN_SLTP_PIPS)) {
        console.log(`❌ entryPrice ${entry} too close to market ${marketPrice} (min ${MIN_SLTP_PIPS})`);
        return res.status(400).json({ ok: false, message: "entry too close to market", marketPrice, entryPrice: entry });
      }

      if (sl && isTooClose(marketPrice, sl, MIN_SLTP_PIPS)) {
        console.log(`❌ stopLoss ${sl} too close to market ${marketPrice} (min ${MIN_SLTP_PIPS})`);
        return res.status(400).json({ ok: false, message: "stopLoss too close to market", stopLossPrice: sl });
      }

      if (tp && isTooClose(marketPrice, tp, MIN_SLTP_PIPS)) {
        console.log(`❌ takeProfit ${tp} too close to market ${marketPrice} (min ${MIN_SLTP_PIPS})`);
        return res.status(400).json({ ok: false, message: "takeProfit too close to market", takeProfitPrice: tp });
      }
    } catch (err) {
      console.warn("⚠️ Pricing check failed, continuing with caution:", err.message);
      // ここで拒否するか続行するかは運用次第。続行する場合はログを残す。
    }

    // --- 重複保留 orders チェック（EPS 許容） ---
    const pending = await getPendingOrders(symbol);
    const sameOrder = pending.find(o => {
      // o.type は "STOP" / "LIMIT" 等
      const sameType = o.type === ot;
      const priceClose = Math.abs(Number(o.price) - entry) < EPS;
      const unitsSignMatch = (side === "LONG" && Number(o.units) > 0) || (side === "SHORT" && Number(o.units) < 0);
      return sameType && priceClose && unitsSignMatch;
    });
    if (sameOrder) {
      console.log("⚠️ 同一の保留 注文が既に存在するためスキップ:", sameOrder.id);
      return res.status(200).json({ ok: true, message: "duplicate pending order" });
    }

    // --- 注文作成 ---
    console.log(`📤 Creating ${ot} order: ${symbol} ${side} units=${wantUnits} entry=${entry} SL=${sl} TP=${tp}`);
    let placeResult;
    try {
      placeResult = await placePendingOrder(symbol, wantUnits, entry, sl, tp, ot);
      // 成功したらクールダウンをセット
      lastOrderTime[key] = now;
    } catch (err) {
      console.error("❌ placePendingOrder failed:", err.message);
      return res.status(500).json({ ok: false, message: "order_failed", error: String(err) });
    }

    return res.status(200).json({
      ok: true,
      action: `${ot.toLowerCase()}_order_created`,
      side,
      requestedEntry: fmtPrice(entry, symbol),
      requestedSL: sl ? fmtPrice(sl, symbol) : null,
      requestedTP: tp ? fmtPrice(tp, symbol) : null,
      raw: placeResult,
    });

  } catch (err) {
    console.error("❌ /webhook error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
