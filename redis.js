var Redis = require("@upstash/redis").Redis;
var config = require("./config");

// 既存の api/sync.js と同じUpstashインスタンスに接続する
var redis = new Redis({ url: config.redisUrl, token: config.redisToken });

var WATCH_KEY = "tachibana:watch";       // フロントが書く「今見ている銘柄」
var QUOTE_KEY_PREFIX = "tachibana:quote:"; // このサーバーが書く「最新の価格・板情報」

function quoteKey(ticker) {
  return QUOTE_KEY_PREFIX + ticker;
}

async function getWatch() {
  var data = await redis.get(WATCH_KEY);
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data;
}

async function setQuote(ticker, quote) {
  // フロントは数秒おきにポーリングする想定なので、少し余裕を持ったTTLにする
  await redis.set(quoteKey(ticker), JSON.stringify(quote), { ex: 30 });
}

module.exports = { getWatch: getWatch, setQuote: setQuote, quoteKey: quoteKey };
