// メインループ:
// 1. Redisの「今フロントで選択中の銘柄」を数秒おきに確認
// 2. 銘柄が変わったらEVENT I/F(WebSocket)の購読を切り替え
// 3. 受信したリアルタイムデータを、一定間隔に間引いてRedisへ書き込む
//    （フロントはこのRedisの値をポーリングして表示する）
// 4. しばらく誰も見ていない場合は接続を切ってAPI負荷を抑える
// 5. 毎日03:30の閉局後は自動で再ログインし、接続を張り直す
// 6. セッション切れ等のエラー応答を受け取ったら、その場で再ログインして張り直す

var auth = require("./auth");
var relay = require("./relay");
var config = require("./config");
var TachibanaEventClient = require("./eventClient");

var eventClient = null;
var latestFields = null;
var latestTicker = null;
var dirty = false;

var lastForcedReLoginAt = 0;
var FORCED_RELOGIN_MIN_INTERVAL_MS = 30 * 1000; // 短時間にエラーが連発しても再ログインを連打しない

function log() {
  var args = Array.prototype.slice.call(arguments);
  console.log.apply(console, ["[watcher]"].concat(args));
}

// 今の接続を破棄する（次のループで新しいセッションを使って自動的に作り直される）
function resetEventClient() {
  if (eventClient) eventClient.stop();
  eventClient = null;
  latestFields = null;
  latestTicker = null;
}

// セッション切れ等のエラー応答を受け取った時の復旧処理
async function handleSessionError(evt) {
  var now = Date.now();
  if (now - lastForcedReLoginAt < FORCED_RELOGIN_MIN_INTERVAL_MS) return;
  lastForcedReLoginAt = now;

  log("セッションエラーを検知（p_errno=" + evt.fields.p_errno + " " + (evt.fields.p_err || "") + "）。再ログインします。");
  try {
    await auth.reLogin();
    log("再ログインに成功しました。接続を張り直します。");
  } catch (e) {
    log("再ログインに失敗:", e.message);
  }
  resetEventClient();
}

async function getOrCreateEventClient() {
  var session = await auth.ensureSession();
  if (!eventClient) {
    eventClient = new TachibanaEventClient(session.sUrlEventWebSocket, config.mktCode);
    eventClient.on("open", function (ticker) { log("接続開始:", ticker); });
    eventClient.on("error", function (err) { log("WebSocketエラー:", err.message); });
    eventClient.on("sessionError", function (evt) {
      handleSessionError(evt).catch(function (e) { log("復旧処理エラー:", e.message); });
    });
    eventClient.on("data", function (evt) {
      latestTicker = evt.ticker;
      latestFields = evt.fields;
      dirty = true;
    });
  }
  return eventClient;
}

async function checkWatchAndSubscribe() {
  // 閉局(03:30)後の日次再ログインが必要なら実施し、接続を張り直す
  var refreshed = await auth.refreshIfNeeded().catch(function (e) {
    log("日次の再ログインに失敗:", e.message);
    return false;
  });
  if (refreshed) {
    log("日次の再ログインを実行しました。接続を張り直します。");
    resetEventClient();
  }

  var watch = null;
  try {
    watch = await relay.getWatch();
  } catch (e) {
    log("Vercel API(watch)読み込み失敗:", e.message);
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
    await relay.setQuote(latestTicker, {
      ticker: latestTicker,
      fields: latestFields,
      updatedAt: Date.now(),
    });
    dirty = false;
  } catch (e) {
    log("Vercel API(quote)書き込み失敗:", e.message);
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
