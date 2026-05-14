import express from "express";
import fetch from "node-fetch";

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 8080;

const {
  OANDA_ACCOUNT_ID,
  OANDA_API_KEY
} = process.env;

const BASE =
  "https://api-fxtrade.oanda.com/v3/accounts";

const FIXED_UNITS = 20000;

const COOLDOWN_MS = 8000;

let lastEntryTime = 0;

let lastEntrySide = null;

/* =========================================
   認証
========================================= */

const auth = {
  Authorization: `Bearer ${OANDA_API_KEY}`,
  "Content-Type": "application/json"
};

const sleep = (ms) =>
  new Promise((r) => setTimeout(r, ms));

/* =========================================
   シンボル変換
========================================= */

function normalizeSymbol(sym) {

  if (sym === "USDJPY")
    return "USD_JPY";

  if (sym === "EURJPY")
    return "EUR_JPY";

  if (sym === "GBPJPY")
    return "GBP_JPY";

  if (sym === "AUDJPY")
    return "AUD_JPY";

  return sym;
}

/* =========================================
   小数桁
========================================= */

function formatPrice(price, symbol) {

  const precisionMap = {
    USD_JPY: 3,
    EUR_JPY: 3,
    GBP_JPY: 3,
    AUD_JPY: 3
  };

  const precision =
    precisionMap[symbol] ?? 5;

  return Number(price).toFixed(precision);
}

/* =========================================
   API
========================================= */

async function fetchJSON(
  url,
  options = {}
) {

  const res = await fetch(url, options);

  const text = await res.text();

  console.log(
    `📡 ${options.method || "GET"} ${url}`
  );

  console.log(
    `📥 [${res.status}] ${text}`
  );

  try {

    return JSON.parse(text);

  } catch {

    return {};
  }
}

/* =========================================
   ポジション取得
========================================= */

async function getPosition(symbol) {

  const r = await fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/openPositions`,
    {
      method: "GET",
      headers: auth
    }
  );

  const pos =
    (r.positions ?? []).find(
      (p) =>
        p.instrument === symbol
    );

  if (!pos)
    return null;

  return {
    long: parseInt(pos.long.units),
    short: parseInt(pos.short.units)
  };
}

function hasPosition(pos) {

  if (!pos)
    return false;

  return (
    pos.long !== 0 ||
    pos.short !== 0
  );
}

/* =========================================
   全決済
========================================= */

async function closeAllSafe(symbol) {

  const pos =
    await getPosition(symbol);

  if (!pos) {

    console.log(
      "ℹ ポジション無し"
    );

    return true;
  }

  let unitsToClose = 0;

  if (pos.long > 0)
    unitsToClose = -pos.long;

  if (pos.short < 0)
    unitsToClose = -pos.short;

  if (unitsToClose === 0)
    return true;

  console.log(
    `🚪 クローズ units=${unitsToClose}`
  );

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

    console.log(
      "✅ クローズ成功"
    );

    return true;
  }

  console.log(
    "❌ クローズ失敗"
  );

  return false;
}

/* =========================================
   Pending削除
========================================= */

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

      console.log(
        `🗑 Pending Cancel ${o.id}`
      );

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

/* =========================================
   MARKET注文
========================================= */

async function placeMarket(
  symbol,
  units,
  slPrice,
  tpPrice
) {

  const sl =
    formatPrice(slPrice, symbol);

  const tp =
    formatPrice(tpPrice, symbol);

  console.log(
    `🎯 SL=${sl} TP=${tp}`
  );

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

/* =========================================
   クールダウン
========================================= */

function cooldownActive(side) {

  if (!lastEntrySide)
    return false;

  if (side !== lastEntrySide)
    return false;

  return (
    Date.now() - lastEntryTime <
    COOLDOWN_MS
  );
}

/* =========================================
   WEBHOOK
========================================= */

app.post(
  "/webhook",
  async (req, res) => {

    res.json({
      received: true
    });

    try {

      const payload =
        req.body.alert_message
          ? JSON.parse(
              req.body.alert_message
            )
          : req.body;

      console.log(
        "📬 WEBHOOK:",
        payload
      );

      const {
        alert,
        symbol,
        stopLossPrice,
        takeProfitPrice
      } = payload;

      if (!symbol) {

        console.log(
          "❌ symbol無し"
        );

        return;
      }

      const symbolFixed =
        normalizeSymbol(symbol);

      /* =========================
         CLOSE処理
      ========================= */

      if (alert === "CLOSE_LONG") {

        console.log(
          "🚪 CLOSE LONG"
        );

        await closeAllSafe(
          symbolFixed
        );

        return;
      }

      if (alert === "CLOSE_SHORT") {

        console.log(
          "🚪 CLOSE SHORT"
        );

        await closeAllSafe(
          symbolFixed
        );

        return;
      }

      /* =========================
         エントリー方向
      ========================= */

      const side =
        alert === "LONG_MARKET"
          ? "LONG"
          : alert === "SHORT_MARKET"
          ? "SHORT"
          : null;

      if (!side) {

        console.log(
          "⚠ 不明アラート"
        );

        return;
      }

      /* =========================
         クールダウン
      ========================= */

      if (
        cooldownActive(side)
      ) {

        console.log(
          "⏳ クールダウン中"
        );

        return;
      }

      const units =
        side === "LONG"
          ? FIXED_UNITS
          : -FIXED_UNITS;

      /* =========================
         現在ポジ
      ========================= */

      const pos =
        await getPosition(
          symbolFixed
        );

      /* =========================
         同方向スキップ
      ========================= */

      if (hasPosition(pos)) {

        if (
          side === "LONG" &&
          pos.long > 0
        ) {

          console.log(
            "⛔ LONG保有中"
          );

          return;
        }

        if (
          side === "SHORT" &&
          pos.short < 0
        ) {

          console.log(
            "⛔ SHORT保有中"
          );

          return;
        }

        /* =========================
           反転
        ========================= */

        console.log(
          "🔁 反転クローズ"
        );

        const closed =
          await closeAllSafe(
            symbolFixed
          );

        if (!closed)
          return;

        await sleep(1000);
      }

      /* =========================
         Pending削除
      ========================= */

      await cancelAll(
        symbolFixed
      );

      /* =========================
         エントリー
      ========================= */

      const result =
        await placeMarket(
          symbolFixed,
          units,
          Number(stopLossPrice),
          Number(takeProfitPrice)
        );

      if (
        result.orderFillTransaction
      ) {

        console.log(
          "✅ エントリー成功"
        );

        lastEntryTime =
          Date.now();

        lastEntrySide =
          side;

      } else {

        console.log(
          "❌ エントリー失敗"
        );
      }

    } catch (err) {

      console.error(
        "❌ ERROR:",
        err
      );
    }
  }
);

/* =========================================
   起動
========================================= */

app.listen(PORT, () => {

  console.log(
    "🚀 MARKET VERSION v3 READY"
  );
});
