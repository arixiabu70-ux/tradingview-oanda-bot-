import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const { OANDA_ACCOUNT_ID, OANDA_API_KEY } = process.env;

const OANDA_API_URL = "https://api-fxtrade.oanda.com/v3/accounts";
const FIXED_UNITS = 20000;

const PRECISION = { USD_JPY: 3 };

const auth = {
  Authorization: `Bearer ${OANDA_API_KEY}`,
  "Content-Type": "application/json"
};

const fmt = (p, s) => Number(p).toFixed(PRECISION[s] ?? 3);

async function fetchJSON(url, options={}) {
  const res = await fetch(url, options);
  const text = await res.text();
  console.log(`📡 ${options.method} ${url}`);
  console.log(`📥 [${res.status}] ${text}`);
  try { return JSON.parse(text); } catch { return {}; }
}

async function closeAll(symbol) {
  return fetchJSON(
    `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/positions/${symbol}/close`,
    {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ longUnits:"ALL", shortUnits:"ALL" })
    }
  );
}

async function cancelAll(symbol) {
  return fetchJSON(
    `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/pendingOrders`,
    { method: "GET", headers: auth }
  ).then(async r => {
    for (const o of r.orders ?? []) {
      if (o.instrument === symbol) {
        await fetchJSON(
          `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders/${o.id}/cancel`,
          { method:"PUT", headers: auth }
        );
      }
    }
  });
}

async function placeLimit(symbol, units, entry, sl, tp) {
  return fetchJSON(
    `${OANDA_API_URL}/${OANDA_ACCOUNT_ID}/orders`,
    {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        order: {
          type:"LIMIT",
          instrument:symbol,
          units:units.toString(),
          price:fmt(entry,symbol),
          timeInForce:"GTC",
          stopLossOnFill:{ price:fmt(sl,symbol) },
          takeProfitOnFill:{ price:fmt(tp,symbol) }
        }
      })
    }
  );
}

app.post("/webhook", async (req, res) => {
  const payload = req.body.alert_message
    ? JSON.parse(req.body.alert_message)
    : req.body;

  console.log("📬 WEBHOOK:", payload);

  const { alert, symbol, entryPrice, stopLossPrice, takeProfitPrice } = payload;

  // ===== ゾーン切替：即時強制 =====
  if (alert === "ZONE_EXIT") {
    await cancelAll(symbol);
    await closeAll(symbol);
    return res.json({ ok:true });
  }

  // ===== ENTRY =====
  const units =
    alert === "LONG_LIMIT"  ?  FIXED_UNITS :
    alert === "SHORT_LIMIT" ? -FIXED_UNITS : 0;

  if (!units) return res.json({ skipped:true });

  await cancelAll(symbol);
  await closeAll(symbol);

  await placeLimit(
    symbol,
    units,
    Number(entryPrice),
    Number(stopLossPrice),
    Number(takeProfitPrice)
  );

  res.json({ ok:true });
});

app.listen(PORT, () =>
  console.log(`🚀 Zone + RR AutoTrade SAFE BOT running`)
);
