// メインループ:
// 1. Redisの「今フロントで選択中の銘柄」を数秒おきに確認
// 2. 銘柄が変わったらEVENT I/F(WebSocket)の購読を切り替え
// 3. 受信したリアルタイムデータを、一定間隔に間引いてRedisへ書き込む
//    （フロントはこのRedisの値をポーリングして表示する）
// 4. しばらく誰も見ていない場合は接続を切ってAPI負荷を抑える
// 5. 毎日8:35（メンテナンス明け）に自動で再ログインし、接続を張り直す
// 6. セッション切れ(p_errno=2)の応答を受け取ったら、その場で再ログインして張り直す
//    （それ以外のエラー番号ではログインせず、接続を切って倍々の待ち時間で再接続するだけ）
// 7. 休場日・営業日の3:00〜8:35は接続を作らず、既存の接続も止める（accessGate.js）

var auth = require("./auth");
var relay = require("./relay");
var config = require("./config");
var accessGate = require("./accessGate");
var TachibanaEventClient = require("./eventClient");

var eventClient = null;
var latestFields = null;
var latestTicker = null;
var dirty = false;

var lastForcedReLoginAt = 0;
var FORCED_RELOGIN_MIN_INTERVAL_MS = 30 * 1000; // 短時間にエラーが連発しても再ログインを連打しない

// ── 歩み値調査用の一時ログ（確認が終わったら削除してOK） ──────────────────
// 銘柄を切り替えた直後から5件だけ、届いたfieldsをそのままログに出す。
// 常時ログすると流量が多く見づらい＆Railwayのログ枠を圧迫するため件数を絞っている。
var debugLogCount = 0;
var DEBUG_LOG_MAX = 5;

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

// エラー応答を受け取った時の復旧処理。client はそのエラーを受け取った接続
// 以前は p_errno が0以外なら何でもセッション切れとみなし、30秒おきに再ログインしうる作りだった。
// 閉局・メンテナンスを表す番号は分かっていないため、ログインするのは p_errno=2 のときだけにする
async function handleSessionError(evt, client) {
  if (client !== eventClient) return; // 既に作り直した古い接続からの通知は無視する
  var errno = String(evt.fields.p_errno);
  var detail = "p_errno=" + errno + " " + (evt.fields.p_err || "");

  if (errno !== "2") {
    // ログインはせず接続だけ切る。再接続は eventClient の待ち時間（3秒から倍々・最大5分）に任せる
    log("エラー応答を受信（" + detail + "）。セッション切れではないため再ログインせず、接続を切ります。");
    client.dropConnection();
    return;
  }

  // この接続を作った後に、別の経路（webapi の再ログインなど）で新しいセッションが取れていれば
  // ログインせず、新しいセッションで接続を作り直すだけでよい
  if (auth.getLoadedAt() > client.sessionLoadedAt) {
    log("セッション切れを受信（" + detail + "）。新しいセッションが既にあるため、ログインせず接続を作り直します。");
    resetEventClient();
    return;
  }

  var now = Date.now();
  if (now - lastForcedReLoginAt < FORCED_RELOGIN_MIN_INTERVAL_MS) {
    client.dropConnection(); // 再ログインは見送り、倍々の待ち時間で再接続させる
    return;
  }
  lastForcedReLoginAt = now;

  log("セッション切れを受信（" + detail + "）。再ログインします。");
  try {
    await auth.reLogin();
    log("再ログインに成功しました。接続を張り直します。");
    resetEventClient();
  } catch (e) {
    // accessGate が止めた場合の理由は accessGate が切り替わり時にログに出している
    log("再ログインに失敗:", e.message);
    // 同じ（切れた）セッションで作り直しても失敗するだけなので、倍々の待ち時間で再接続させる
    if (client === eventClient) client.dropConnection();
  }
}

async function getOrCreateEventClient() {
  var session = await auth.ensureSession();
  if (!eventClient) {
    var client = new TachibanaEventClient(session.sUrlEventWebSocket, config.mktCode);
    // どのセッションで作った接続かを覚えておく（p_errno=2 のとき、新しいセッションが既にあるかを見る）
    client.sessionLoadedAt = auth.getLoadedAt();
    eventClient = client;
    eventClient.on("open", function (ticker) { log("接続開始:", ticker); });
    eventClient.on("error", function (err) { log("WebSocketエラー:", err.message); });
    eventClient.on("sessionError", function (evt) {
      handleSessionError(evt, client).catch(function (e) { log("復旧処理エラー:", e.message); });
    });
    eventClient.on("data", function (evt) {
      // EVENT I/Fは差分（変化した項目だけ）を送ってくるため、丸ごと置き換えると
      // 前回までに受け取った板情報（気配値）などが消えてしまう。
      // 既存のlatestFieldsに新しい値を上書きする形でマージして保持する。
      latestTicker = evt.ticker;
      latestFields = Object.assign({}, latestFields, evt.fields);
      dirty = true;

      // ── 歩み値調査用の一時ログ ──
      if (debugLogCount < DEBUG_LOG_MAX) {
        debugLogCount++;
        log("[歩み値調査 " + debugLogCount + "/" + DEBUG_LOG_MAX + "] fields=", JSON.stringify(evt.fields));
      }
    });
  }
  return eventClient;
}

async function checkWatchAndSubscribe() {
  // メンテナンス明け(8:35)の日次再ログインが必要なら実施し、接続を張り直す
  var refreshed = await auth.refreshIfNeeded().catch(function (e) {
    // 送信を止めた場合は3秒おきに同じログが出るので出さない（理由は accessGate が切り替わり時に出す）
    if (!e.blocked) log("日次の再ログインに失敗:", e.message);
    return false;
  });
  if (refreshed) {
    log("日次の再ログインを実行しました。接続を張り直します。");
    resetEventClient();
  }

  // 休場日・営業日の3:00〜8:35は接続を作らず、張ったままの接続も止める（立花が閉まっている間に
  // 接続を持ち続けない・ログインを試みないため）。一時停止中は新しく接続しないだけで、既存の接続は残す
  var blocked = accessGate.check(Date.now());
  if (blocked && blocked.reason !== "paused") {
    if (eventClient && eventClient.currentTicker !== null) {
      log("立花が閉まっている時間のため接続を止めます");
      eventClient.stop();
      latestFields = null;
      latestTicker = null;
    }
    return;
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

  // 見ている銘柄が無いときは接続を作らない（接続を作るとログインが走るため）。
  // 既存の接続が購読中なら止めるだけにする
  if (desiredTicker === null) {
    if (eventClient && eventClient.currentTicker !== null) {
      log("監視終了（一定時間、誰も見ていません）");
      eventClient.stop();
      latestFields = null;
      latestTicker = null;
    }
    return;
  }

  var client = await getOrCreateEventClient().catch(function (e) {
    if (!e.blocked) log("ログイン/セッション取得に失敗:", e.message);
    return null;
  });
  if (!client) return;

  if (client.currentTicker !== desiredTicker) {
    log("監視銘柄を切り替え:", client.currentTicker, "→", desiredTicker);
    debugLogCount = 0; // 銘柄を切り替えるたびに、新しい銘柄で改めて5件ログする
    // 前の銘柄のfieldsを持ち越さないよう、切り替え時に必ずリセットする
    // （マージ処理を入れたことで、ここをリセットし忘れると前の銘柄のデータが
    //   新しい銘柄のデータに混ざり込んでしまうため）
    latestFields = null;
    latestTicker = null;
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

// 前回の checkWatchAndSubscribe が終わっていない間は次の回を始めない。
// ログインや Vercel API の応答が遅いと、重なった回がそれぞれログインを試してしまうため
var checkRunning = false;

function start() {
  log("起動しました。ポーリング間隔:", config.watchPollIntervalSeconds, "秒 / 書き込み間隔:", config.quoteWriteMinIntervalSeconds, "秒");
  setInterval(function () {
    if (checkRunning) return;
    checkRunning = true;
    checkWatchAndSubscribe()
      .catch(function (e) { log("予期しないエラー:", e.message); })
      .finally(function () { checkRunning = false; });
  }, config.watchPollIntervalSeconds * 1000);

  setInterval(function () {
    flushToRedisIfDirty().catch(function (e) { log("予期しないエラー:", e.message); });
  }, config.quoteWriteMinIntervalSeconds * 1000);
}

module.exports = { start: start };
