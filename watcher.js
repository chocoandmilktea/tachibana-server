// メインループ:
// 1. Redisの「今フロントで選択中の銘柄」を数秒おきに確認
// 2. 銘柄が変わったらEVENT I/F(WebSocket)の購読を切り替え
// 3. 受信したリアルタイムデータを、一定間隔に間引いてRedisへ書き込む
//    （フロントはこのRedisの値をポーリングして表示する）
// 4. しばらく誰も見ていない場合は接続を切ってAPI負荷を抑える

var auth = require("./auth");
var redisMod = require("./redis");
var config = require("./config");
var TachibanaEventClient = require("./eventClient");

var eventClient = null;
var latestFields = null;
var latestTicker = null;
var dirty = false;

function log() {
  var args = Array.prototype.slice.call(arguments);
  console.log.apply(console, ["[watcher]"].concat(args));
}

async function getOrCreateEventClient() {
  var session = await auth.ensureSession();
  if (!eventClient) {
    eventClient = new TachibanaEventClient(session.sUrlEventWebSocket, config.mktCode);
    eventClient.on("open", function (ticker) { log("接続開始:", ticker); });
    eventClient.on("error", function (err) { log("WebSocketエラー:", err.message); });
    eventClient.on("data", function (evt) {
      latestTicker = evt.ticker;
      latestFields = evt.fields;
      dirty = true;
    });
  }
  return eventClient;
}

async function checkWatchAndSubscribe() {
  var watch = null;
  try {
    watch = await redisMod.getWatch();
  } catch (e) {
    log("Redis読み込み失敗:", e.message);
    return;
  }

  var desiredTicker = null;
  if (watch && watch.ticker && watch.ts) {
    var ageSeconds = (Date.now() - watch.ts) / 1000;
    if (ageSeconds <= config.watchStaleSeconds) desiredTicker = watch.ticker;
  }

  var client = await getOrCreateEventClient().catch(function (e) {
    log("ログイン/セッション取得に失敗:", e.message);
    return null;
  });
  if (!client) return;

  if (desiredTicker === null) {
    if (client.currentTicker !== null) {
      log("監視終了（一定時間、誰も見ていません）");
      client.stop();
      latestFields = null;
      latestTicker = null;
    }
    return;
  }

  if (client.currentTicker !== desiredTicker) {
    log("監視銘柄を切り替え:", client.currentTicker, "→", desiredTicker);
    client.subscribe(desiredTicker);
  }
}

async function flushToRedisIfDirty() {
  if (!dirty || !latestTicker || !latestFields) return;
  try {
    await redisMod.setQuote(latestTicker, {
      ticker: latestTicker,
      fields: latestFields,
      updatedAt: Date.now(),
    });
    dirty = false;
  } catch (e) {
    log("Redis書き込み失敗:", e.message);
  }
}

function start() {
  log("起動しました。ポーリング間隔:", config.watchPollIntervalSeconds, "秒 / 書き込み間隔:", config.quoteWriteMinIntervalSeconds, "秒");
  setInterval(function () {
    checkWatchAndSubscribe().catch(function (e) { log("予期しないエラー:", e.message); });
  }, config.watchPollIntervalSeconds * 1000);

  setInterval(function () {
    flushToRedisIfDirty().catch(function (e) { log("予期しないエラー:", e.message); });
  }, config.quoteWriteMinIntervalSeconds * 1000);
}

module.exports = { start: start };
