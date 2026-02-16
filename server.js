import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const { OANDA_ACCOUNT_ID, OANDA_API_KEY } = process.env;

const BASE = "https://api-fxtrade.oanda.com/v3/accounts";
const FIXED_UNITS = 20000;

const PRECISION = { USD_JPY: 3 };

const COOLDOWN_MS = 8000;
const POST_CLOSE_WAIT = 3000;

let processing = false;
let lastCloseTime = 0;

const auth = {
  Authorization: `Bearer ${OANDA_API_KEY}`,
  "Content-Type": "application/json"
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (p, s) => Number(p).toFixed(PRECISION[s] ?? 3);

// ==============================
async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  console.log(`📡 ${options.method} ${url}`);
  console.log(`📥 [${res.status}] ${text}`);
  try { return JSON.parse(text); } catch { return {}; }
}

// ==============================
async function hasPosition(symbol) {
  const r = await fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/openPositions`,
    { method: "GET", headers: auth }
  );
  return (r.positions ?? []).some(p => p.instrument === symbol);
}

// ==============================
// 成り行きクローズ（成功確認付き）
// ==============================
async function closeAllSafe(symbol) {

  const r = await fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/positions/${symbol}/close`,
    {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        longUnits: "ALL",
        shortUnits: "ALL"
      })
    }
  );

  // 成功判定（トランザクション確認）
  if (r.longOrderFillTransaction || r.shortOrderFillTransaction) {
    console.log("✅ 成り行き決済トランザクション確認");
    return true;
  }

  console.log("❌ 成り行き決済失敗の可能性");
  return false;
}

// ==============================
async function cancelAll(symbol) {

  const r = await fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/pendingOrders`,
    { method: "GET", headers: auth }
  );

  for (const o of r.orders ?? []) {
    if (o.instrument === symbol) {
      await fetchJSON(
        `${BASE}/${OANDA_ACCOUNT_ID}/orders/${o.id}/cancel`,
        { method: "PUT", headers: auth }
      );
    }
  }
}

// ==============================
async function placeLimit(symbol, units, entry, sl, tp) {

  return fetchJSON(
    `${BASE}/${OANDA_ACCOUNT_ID}/orders`,
    {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        order: {
          type: "LIMIT",
          instrument: symbol,
          units: units.toString(),
          price: fmt(entry, symbol),
          timeInForce: "GTC",
          positionFill: "OPEN_ONLY", // 🔥 相殺完全防止
          stopLossOnFill: { price: fmt(sl, symbol) },
          takeProfitOnFill: { price: fmt(tp, symbol) }
        }
      })
    }
  );
}

function cooldownActive() {
  return Date.now() - lastCloseTime < COOLDOWN_MS;
}

// ==================================================
app.post("/webhook", async (req, res) => {

  if (processing) {
    console.log("⚠ 多重Webhook防止");
    return res.json({ skipped: true });
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
      entryPrice,
      stopLossPrice,
      takeProfitPrice
    } = payload;

    if (!symbol) return res.json({ skipped: true });

    // ==============================
    // ZONE_EXIT
    // ==============================
    if (alert === "ZONE_EXIT") {

      console.log("🚪 ZONE_EXIT");

      await cancelAll(symbol);

      if (await hasPosition(symbol)) {

        const success = await closeAllSafe(symbol);

        if (!success) {
          console.log("❌ 成り行き失敗 → 強制終了");
          return res.status(500).json({ error: "close failed" });
        }

        // 完全ゼロ確認
        let retry = 0;
        while (await hasPosition(symbol) && retry < 20) {
          await sleep(500);
          retry++;
        }

        if (await hasPosition(symbol)) {
          console.log("❌ ポジション消えない → エントリー禁止");
          return res.status(500).json({ error: "position not cleared" });
        }

        console.log("✅ ポジション完全ゼロ確認");

        await sleep(POST_CLOSE_WAIT);
        lastCloseTime = Date.now();
      }

      return res.json({ ok: true });
    }

    // ==============================
    // ENTRY
    // ==============================

    const units =
      alert === "LONG_LIMIT"  ?  FIXED_UNITS :
      alert === "SHORT_LIMIT" ? -FIXED_UNITS : 0;

    if (!units) return res.json({ skipped: true });

    if (cooldownActive()) {
      console.log("⏳ クールダウン中");
      return res.json({ skipped: true });
    }

    await cancelAll(symbol);

    if (await hasPosition(symbol)) {

      console.log("🔁 反転処理開始");

      const success = await closeAllSafe(symbol);

      if (!success) {
        console.log("❌ 成り行き失敗 → 新規禁止");
        return res.status(500).json({ error: "close failed" });
      }

      let retry = 0;
      while (await hasPosition(symbol) && retry < 20) {
        await sleep(500);
        retry++;
      }

      if (await hasPosition(symbol)) {
        console.log("❌ ポジション残存 → エントリー中止");
        return res.status(500).json({ error: "position not cleared" });
      }

      await sleep(POST_CLOSE_WAIT);
      lastCloseTime = Date.now();
    }

    if (cooldownActive()) {
      console.log("⏳ 反転直後クールダウン");
      return res.json({ skipped: true });
    }

    await placeLimit(
      symbol,
      units,
      Number(entryPrice),
      Number(stopLossPrice),
      Number(takeProfitPrice)
    );

    console.log("🚀 新規LIMIT発注完了");

    return res.json({ ok: true });

  } catch (err) {

    console.error("❌ ERROR:", err);
    return res.status(500).json({ error: true });

  } finally {
    processing = false;
  }
});

app.listen(PORT, () =>
  console.log("🚀 Zone Ultra Safe Institutional Version running")
);
