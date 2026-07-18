require("dotenv").config();

function must(name) {
  var v = process.env[name];
  if (!v) throw new Error("環境変数 " + name + " が設定されていません（.envを確認してください）");
  return v;
}

var isDemo = (process.env.TACHIBANA_ENV || "demo") !== "production";

module.exports = {
  isDemo: isDemo,
  urlAuth: isDemo
    ? must("TACHIBANA_URL_AUTH_DEMO")
    : must("TACHIBANA_URL_AUTH_PROD"),
  authId: must("TACHIBANA_AUTH_ID"),
  privateKeyPem: must("TACHIBANA_PRIVATE_KEY"),
  mktCode: process.env.TACHIBANA_MKT_CODE || "00",
  redisUrl: must("UPSTASH_REDIS_REST_URL"),
  redisToken: must("UPSTASH_REDIS_REST_TOKEN"),
  watchStaleSeconds: parseInt(process.env.WATCH_STALE_SECONDS || "120", 10),
  quoteWriteMinIntervalSeconds: parseInt(process.env.QUOTE_WRITE_MIN_INTERVAL_SECONDS || "5", 10),
  watchPollIntervalSeconds: parseInt(process.env.WATCH_POLL_INTERVAL_SECONDS || "3", 10),
};
