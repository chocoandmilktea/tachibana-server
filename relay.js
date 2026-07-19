// Redisには直接繋がず、VercelのAPI(tachibana-watch / tachibana-quote)経由でやり取りする。
// これによりRailway側にRedisの認証情報を持たせる必要がなくなる。

var config = require("./config");

function authHeaders() {
  var h = { "Content-Type": "application/json" };
  if (config.relaySecret) h["X-Relay-Secret"] = config.relaySecret;
  return h;
}

// フロントが今見ている銘柄を取得する（無ければ null）
async function getWatch() {
  var res = await fetch(config.watchApi, { headers: authHeaders() });
  var json = await res.json();
  if (!json.found) return null;
  return { ticker: json.ticker, ts: json.ts };
}

// 最新の株価・板情報をVercel経由でRedisに書き込む
async function setQuote(ticker, quote) {
  await fetch(config.quoteApi, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ ticker: ticker, fields: quote.fields, updatedAt: quote.updatedAt }),
  });
}

module.exports = { getWatch: getWatch, setQuote: setQuote };
