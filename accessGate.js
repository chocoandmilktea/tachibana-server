// tachibana-server/accessGate.js
// 立花証券へ「今送ってよいか」を判定する関所。立花への出口（auth.js の postSerialized と
// eventClient.js の _connect）は、送る前に必ずここを通す。
//
// 【なぜ必要か】
// 立花証券から「ログイン回数が多すぎる（1日1回でよい）」「閉局中・休日・メンテナンス中に
// アクセスしている」と注意を受け、改善しなければ利用を止めると言われたため。
// それまで時間帯や休日で送信を止める仕組みは bookLogger.js にしか無かった。
//
// 止めるのは次のとき（判定はすべて日本時間。Railwayの時計のタイムゾーンには頼らない）
//   1. 休場日（土日・祝日・年末年始。holidays.js の isMarketClosed で判定）
//   1b. 営業日で前日が休場日なら 0:00〜8:35（月曜・祝日明けの未明も閉局中のため）
//   2. 営業日の 3:00〜8:35（立花のメンテナンス・サービス停止時間。8:35ちょうどからは送ってよい）
//   3. 一時停止中（通信が3回続けて失敗したら5分間すべて止める）
// ログインはさらに、前回の送信から10分たつまで送らない・1日5回まで、の上限を設ける。
//
// 【休止中（TACHIBANA_SUSPENDED=true）】
// 立花APIが止まっている間（2027年3月に再開予定）は、上の条件より先に、時刻にかかわらず
// すべての送信とログインを止める。休止中はログインにHTMLが返り、毎営業日ログイン上限まで
// 失敗し続けていたため。サーバー自体は止めない（scanner.js が Vercel へ定時スキャンを頼み続けるため）。
// 値がちょうど "true" のときだけ休止とみなす。未設定や "true" 以外は休止前とまったく同じ動きにする。
// 環境変数だが config.js を通さずここで直接読む（config.js は立花の接続設定の置き場で、
// 休止の判定はこのファイルだけで完結させるため）。
//
// 判定する関数は現在時刻(epoch ms)を引数で受け取れる（省略時は Date.now()）。
// 立花へ送らずに node から時刻を渡して確かめられるようにするため。

var holidays = require("./holidays");

function log() {
  var args = Array.prototype.slice.call(arguments);
  console.log.apply(console, ["[gate]"].concat(args));
}

// ── 設定（環境変数にはしない。README の環境変数一覧と食い違わせないため） ──
// 例外は休止の切り替え TACHIBANA_SUSPENDED だけ（README の環境変数一覧への追記は別途必要）
var MAINT_START_MIN = 3 * 60; // 3:00 から止める
var MAINT_END_MIN = 8 * 60 + 35; // 8:35 ちょうどからは送ってよい
var FAIL_LIMIT = 3; // この回数続けて失敗したら一時停止
var PAUSE_MS = 5 * 60 * 1000; // 一時停止の長さ
var LOGIN_MIN_INTERVAL_MS = 10 * 60 * 1000; // ログインを送ってから次を送れるまでの間隔
var LOGIN_DAILY_MAX = 5; // 1日（日本時間の日付）あたりのログイン上限
var SUSPENDED = process.env.TACHIBANA_SUSPENDED === "true"; // 立花API休止中なら true（起動時に1回だけ読む）
var SUSPENDED_RESULT = { reason: "suspended", message: "立花API休止中（TACHIBANA_SUSPENDED）" };

// ── 状態 ─────────────────────────────────────────────────────────────
var failCount = 0; // 通信の連続失敗回数（成功で0に戻す）
var pausedUntil = 0; // 一時停止が明ける時刻(epoch ms)。0なら停止していない
var lastFailReason = "";
var loginDate = ""; // loginCount を数えている日付（日本時間 YYYY-MM-DD）
var loginCount = 0; // その日に送ったログインの回数
var lastLoginSentAt = 0; // 最後にログインを送った時刻(epoch ms)
var lastSendBlockKey = null; // 直前の送信判定で止めた理由（ログを切り替わり時だけ出すため）
var lastLoginBlockKey = null; // 直前のログイン判定で止めた理由
var suspendedLogged = false; // 休止中で止めたことを既にログに出したか（起動してから1回だけ出す）

// 日本時間の日付と、0時からの経過分を返す
function jstParts(nowMs) {
  var jst = new Date(nowMs + 9 * 60 * 60 * 1000);
  return {
    date: jst.toISOString().slice(0, 10),
    minutes: jst.getUTCHours() * 60 + jst.getUTCMinutes(),
  };
}

// 休場日判定は日付ごとに1回だけ holidays.js に聞く。
// 判定は秒単位で何度も呼ばれるため、対応年外の警告ログが毎回出るのを防ぐ。
// 当日と前日を交互に聞くので、1日分ではなく数日分を覚えておく
var closedCache = {};
var closedCacheSize = 0;
function isClosedDate(dateStr) {
  if (!Object.prototype.hasOwnProperty.call(closedCache, dateStr)) {
    if (closedCacheSize >= 10) { closedCache = {}; closedCacheSize = 0; }
    closedCache[dateStr] = holidays.isMarketClosed(dateStr);
    closedCacheSize += 1;
  }
  return closedCache[dateStr];
}

// "YYYY-MM-DD" の前日
function prevDateStr(dateStr) {
  return new Date(Date.parse(dateStr + "T00:00:00Z") - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 営業日で、前日が休場日の場合は 0:00〜8:35 を止める（例：月曜・祝日明けの 0:00〜3:00）。
// 3:00〜8:35 は別の条件でも止まるが、ここでは 0:00 から 8:35 までをまとめて判定する
function judgeAfterHoliday(p) {
  if (p.minutes >= MAINT_END_MIN) return null;
  if (isClosedDate(p.date) || !isClosedDate(prevDateStr(p.date))) return null;
  return { reason: "after-holiday", message: "休場日明けの営業日の0:00〜8:35のため立花へ送りません" };
}

function isClosedDay(nowMs) {
  return isClosedDate(jstParts(nowMs == null ? Date.now() : nowMs).date);
}

function fmtTime(ms) {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(11, 19);
}

// ── 送信してよいかの判定（副作用なし） ─────────────────────────────────
// 送ってよければ null、止めるなら { reason, message } を返す
function judgeSend(nowMs) {
  if (SUSPENDED) return SUSPENDED_RESULT; // 休止中は時刻にかかわらず止める
  var now = nowMs == null ? Date.now() : nowMs;
  var p = jstParts(now);
  if (isClosedDate(p.date)) {
    return { reason: "holiday", message: "休場日（" + p.date + "）のため立花へ送りません" };
  }
  var afterHoliday = judgeAfterHoliday(p);
  if (afterHoliday) return afterHoliday;
  if (p.minutes >= MAINT_START_MIN && p.minutes < MAINT_END_MIN) {
    return { reason: "maintenance", message: "営業日の3:00〜8:35（メンテナンス・サービス停止時間）のため立花へ送りません" };
  }
  if (now < pausedUntil) {
    return {
      reason: "paused",
      message: "通信の失敗が" + FAIL_LIMIT + "回続いたため一時停止中です（" + fmtTime(pausedUntil) + "まで）",
    };
  }
  return null;
}

// ── ログインを送ってよいかの判定（副作用なし） ─────────────────────────
function judgeLogin(nowMs) {
  if (SUSPENDED) return SUSPENDED_RESULT; // 休止中は時刻にかかわらず止める
  var now = nowMs == null ? Date.now() : nowMs;
  var p = jstParts(now);
  // 休場日明けの 0:00〜8:35 はログインも送らない（呼び出し側は judgeSend も必ず通すが、念のためここでも見る）
  var afterHoliday = judgeAfterHoliday(p);
  if (afterHoliday) return afterHoliday;
  var count = loginDate === p.date ? loginCount : 0;
  if (count >= LOGIN_DAILY_MAX) {
    return { reason: "login-daily-limit", message: "本日のログインが上限（" + LOGIN_DAILY_MAX + "回）に達したため送りません" };
  }
  var waitMs = lastLoginSentAt + LOGIN_MIN_INTERVAL_MS - now;
  if (lastLoginSentAt && waitMs > 0) {
    return {
      reason: "login-interval",
      message: "前回のログインから10分たっていないため送りません（あと" + Math.ceil(waitMs / 1000) + "秒）",
    };
  }
  return null;
}

// ── 判定＋状態が切り替わったときだけログ ─────────────────────────────
// 呼び出しのたびにログを出すと、3秒おきの監視ループや Vercel からの問い合わせで埋まるため。
// 休止中で止めたことは、送信・ログインのどちらの判定で止めたかにかかわらず起動してから1回だけ出す
function logSuspendedOnce() {
  if (suspendedLogged) return;
  suspendedLogged = true;
  log("送信を止めます:", SUSPENDED_RESULT.message + "。再開するまで立花へは一切送りません（このログは起動してから1回だけ出します）");
}

function check(nowMs) {
  var result = judgeSend(nowMs);
  if (result === SUSPENDED_RESULT) {
    logSuspendedOnce();
    lastSendBlockKey = result.reason;
    return result;
  }
  var key = result ? result.reason : null;
  if (key !== lastSendBlockKey) {
    if (result) log("送信を止めます:", result.message);
    else log("送信を再開します（止めていた理由: " + lastSendBlockKey + "）");
    lastSendBlockKey = key;
  }
  return result;
}

function checkLogin(nowMs) {
  var result = judgeLogin(nowMs);
  if (result === SUSPENDED_RESULT) {
    logSuspendedOnce();
    lastLoginBlockKey = result.reason;
    return result;
  }
  var key = result ? result.reason : null;
  if (key !== lastLoginBlockKey) {
    if (result) log("ログインを止めます:", result.message);
    lastLoginBlockKey = key;
  }
  return result;
}

// 「送信を止めた」ことが分かる印付きのエラー。呼び出し側は e.blocked で見分ける
function blockedError(result) {
  var err = new Error("立花への送信を止めました: " + result.message);
  err.blocked = true;
  err.reason = result.reason;
  return err;
}

// ログインを送る直前に呼ぶ（成功・失敗にかかわらず1回と数える）
function recordLoginSent(nowMs) {
  var now = nowMs == null ? Date.now() : nowMs;
  var p = jstParts(now);
  if (loginDate !== p.date) {
    loginDate = p.date;
    loginCount = 0;
  }
  loginCount += 1;
  lastLoginSentAt = now;
  lastLoginBlockKey = null;
  log("ログインを送信します（本日 " + loginCount + "回目 / 上限" + LOGIN_DAILY_MAX + "回）");
}

// ── 通信結果の記録 ───────────────────────────────────────────────────
// 失敗として数えるのは「通信の例外・タイムアウト・JSONとして読めない応答」と
// 「p_errno が 0・2・6 のどれでもない応答」。
// p_errno=2（セッション切れ）と 6（通番エラー）は auth.js が再ログイン・再送で引き受けるため数えない。
// p_errno=0 なら sResultCode がエラー（銘柄コードの誤りなど）でも通信としては成功なので0に戻す
function recordAnswer(ans, nowMs) {
  var errno = ans && ans.p_errno != null ? String(ans.p_errno) : "unknown";
  if (errno === "0") return recordSuccess();
  if (errno === "2" || errno === "6") return;
  recordFailure("p_errno=" + errno + " " + ((ans && ans.p_err) || ""), nowMs);
}

function recordSuccess() {
  failCount = 0;
}

function recordFailure(reason, nowMs) {
  var now = nowMs == null ? Date.now() : nowMs;
  failCount += 1;
  lastFailReason = String(reason || "");
  // 一時停止中に届いた失敗（停止前に送っていた分の応答）では停止を延ばさない。
  // 停止明けは失敗回数を戻さないので、最初の1回がまた失敗すればすぐに次の5分へ入る
  if (failCount >= FAIL_LIMIT && now >= pausedUntil) {
    pausedUntil = now + PAUSE_MS;
    lastSendBlockKey = "paused"; // 止め始めのログはここで出す（check で二重に出さない）
    log("送信を止めます: 通信が" + failCount + "回続けて失敗したため5分間（" + fmtTime(pausedUntil) +
      "まで）すべての送信を止めます。最後の失敗: " + lastFailReason);
  }
}

// 動作確認用に状態を初期化する（本番コードからは呼ばない）
function _resetForTest() {
  failCount = 0;
  pausedUntil = 0;
  lastFailReason = "";
  loginDate = "";
  loginCount = 0;
  lastLoginSentAt = 0;
  lastSendBlockKey = null;
  lastLoginBlockKey = null;
}

// 起動時に設定を1行で出す（このファイルは auth.js から起動時に読み込まれる）
log("設定: 休場日と営業日の3:00〜8:35（休場日明けは0:00〜8:35）は送信しない / ログインは10分以上あけて1日" + LOGIN_DAILY_MAX +
  "回まで / 通信が" + FAIL_LIMIT + "回続けて失敗したら5分間停止 / 立花API休止中: " +
  (SUSPENDED ? "はい（TACHIBANA_SUSPENDED=true。時刻にかかわらずすべての送信とログインを止める）" : "いいえ"));

module.exports = {
  judgeSend: judgeSend,
  judgeLogin: judgeLogin,
  check: check,
  checkLogin: checkLogin,
  blockedError: blockedError,
  recordLoginSent: recordLoginSent,
  recordAnswer: recordAnswer,
  recordSuccess: recordSuccess,
  recordFailure: recordFailure,
  isClosedDay: isClosedDay,
  _resetForTest: _resetForTest,
};
