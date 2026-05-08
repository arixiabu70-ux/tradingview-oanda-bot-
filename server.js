import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

const {
  OANDA_ACCOUNT_ID,
  OANDA_API_KEY
} = process.env;

const BASE = "https://api-fxtrade.oanda.com/v3/accounts";

const FIXED_UNITS = 20000;

const COOLDOWN_MS = 8000;
const POST_CLOSE_WAIT = 3000;

let processing = false;
let lastEntryTime = 0;
let lastEntrySide = null;

/* =============================
   認証
============================= */

const auth = {
  Authorization: `Bearer ${OANDA_API_KEY}`,
  "Content-Type": "application/json"
};

const sleep = (ms) =>
  new Promise((r) => setTimeout(r, ms));

/* =============================
   シンボル変換
============================= */

function normalizeSymbol(sym) {
  if (sym === "USDJPY") return "USD_JPY";
  if (sym === "EURJPY") return "EUR_JPY";
  if (sym === "GBPJPY") return "GBP_JPY";

  return sym;
}

/* =============================
   価格フォーマット
============================= */

function formatPrice(price, symbol) {
  const precisionMap = {
    USD_JPY: 3,
    EUR_JPY: 3,
    GBP_JPY: 3
  };

  const precision = precisionMap[symbol] ?? 5;

  return Number(price).toFixed(precision);
}

/* =============================
   API通信
============================= */

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);

  const text = await res.text();

  console.log(`📡 ${options.method} ${url}`);
  console.log(`📥 [${res.status}] ${text}`);

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/* =============================
   現在ポジ取得
============================= */

async function getPosition(symbol) {
  const r = await fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/openPositions`,
    {
      method: "GET",
      headers: auth
    }
  );

  const pos = (r.positions ?? []).find(
    (p) => p.instrument === symbol
  );

  if (!pos) return null;

  return {
    long: parseInt(pos.long.units),
    short: parseInt(pos.short.units)
  };
}

function hasPosition(pos) {
  if (!pos) return false;

  return pos.long !== 0 || pos.short !== 0;
}

/* =============================
   全決済
============================= */

async function closeAllSafe(symbol) {
  const pos = await getPosition(symbol);

  if (!pos) {
    console.log("ℹ ポジション無し");
    return true;
  }

  let unitsToClose = 0;

  if (pos.long > 0) unitsToClose = -pos.long;

  if (pos.short < 0) unitsToClose = -pos.short;

  if (unitsToClose === 0) return true;

  const body = {
    order: {
      type: "MARKET",
      instrument: symbol,
      units: unitsToClose.toString(),
      timeInForce: "FOK",
      positionFill: "DEFAULT"
    }
  };

  const r = await fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/orders`,
    {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body)
    }
  );

  if (r.orderFillTransaction) {
    console.log("✅ MARKETクローズ成功");
    return true;
  }

  console.log("❌ MARKETクローズ失敗");

  return false;
}

/* =============================
   全注文キャンセル
============================= */

async function cancelAll(symbol) {
  const r = await fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/pendingOrders`,
    {
      method: "GET",
      headers: auth
    }
  );

  for (const o of r.orders ?? []) {
    if (o.instrument === symbol) {
      await fetchJSON(
        `${BASE}/${OANDA_ACCOUNT_ID}/orders/${o.id}/cancel`,
        {
          method: "PUT",
          headers: auth
        }
      );
    }
  }
}

/* =============================
   MARKET注文
============================= */

async function placeMarket(
  symbol,
  units,
  slPrice,
  tpPrice
) {
  const sl = formatPrice(slPrice, symbol);
  const tp = formatPrice(tpPrice, symbol);

  console.log(`🎯 SL: ${sl} / TP: ${tp}`);

  return fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/orders`,
    {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        order: {
          type: "MARKET",
          instrument: symbol,
          units: units.toString(),
          timeInForce: "FOK",
          positionFill: "DEFAULT",

          takeProfitOnFill: {
            price: tp
          },

          stopLossOnFill: {
            price: sl
          }
        }
      })
    }
  );
}

/* =============================
   クールダウン
============================= */

function cooldownActive(side) {
  if (!lastEntrySide) return false;

  if (side !== lastEntrySide) return false;

  return (
    Date.now() - lastEntryTime <
    COOLDOWN_MS
  );
}

/* =============================
   WEBHOOK
============================= */

app.post("/webhook", async (req, res) => {
  res.json({ received: true });

  if (processing) {
    console.log("⚠ 多重Webhook防止");
    return;
  }

  processing = true;

  try {
    const payload = req.body.alert_message
      ? JSON.parse(req.body.alert_message)
      : req.body;

    console.log("📬 WEBHOOK:", payload);

    const {
      alert,
      symbol,
      stopLossPrice,
      takeProfitPrice
    } = payload;

    if (!symbol) return;

    const symbolFixed =
      normalizeSymbol(symbol);

    /* ===== ZONE EXIT ===== */

    if (alert === "ZONE_EXIT") {
      console.log("🚪 ZONE_EXIT");

      await cancelAll(symbolFixed);

      await closeAllSafe(symbolFixed);

      await sleep(POST_CLOSE_WAIT);

      lastEntrySide = null;

      return;
    }

    /* ===== エントリー判定 ===== */

    const side =
      alert === "LONG_MARKET"
        ? "LONG"
        : alert === "SHORT_MARKET"
        ? "SHORT"
        : null;

    if (!side) return;

    const units =
      side === "LONG"
        ? FIXED_UNITS
        : -FIXED_UNITS;

    /* ===== クールダウン ===== */

    if (cooldownActive(side)) {
      console.log("⏳ クールダウン中");
      return;
    }

    const pos = await getPosition(symbolFixed);

    /* ===== 1ポジ制御 ===== */

    if (hasPosition(pos)) {
      if (
        (side === "LONG" && pos.long > 0) ||
        (side === "SHORT" && pos.short < 0)
      ) {
        console.log("⛔ 同方向スキップ");
        return;
      }

      console.log("🔁 反転クローズ");

      const success =
        await closeAllSafe(symbolFixed);

      if (!success) return;

      await sleep(POST_CLOSE_WAIT);
    }

    /* ===== 保留注文削除 ===== */

    await cancelAll(symbolFixed);

    /* ===== エントリー ===== */

    const result = await placeMarket(
      symbolFixed,
      units,
      Number(stopLossPrice),
      Number(takeProfitPrice)
    );

    if (result.orderFillTransaction) {
      console.log("✅ エントリー成功");
    } else {
      console.log("❌ エントリー失敗");
    }

    lastEntryTime = Date.now();
    lastEntrySide = side;
  } catch (err) {
    console.error("❌ ERROR:", err);
  } finally {
    processing = false;
  }
});

/* =============================
   起動
============================= */

app.listen(PORT, () => {
  console.log("🚀 MARKET VERSION v2 READY");
});
