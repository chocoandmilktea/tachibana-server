// tachibana-server/premarketLogger.js
// 寄り前（8:45〜9:06）の気配推移を自動で貯めるロガー。
//
// これまでは /market-price を手で叩いて観測していたが、それだと毎朝端末を
// 開いておく必要がある。常駐しているこのサーバー自身が15秒おきに取得し、
// 9:06になったらその日ぶんをまとめて Vercel（api/sync.js?resource=premarket-log）
// へPOSTして保存する。
//
// 【方針】
// ・立花の戻り値は一切加工しない（後から何が取れていたのかを検証するため）
// ・エラーも握りつぶさず同じ配列に積む（ログイン未確立・カラム不正の切り分け用）
// ・時刻判定は必ずJST。Railwayのサーバー時刻はUTCなので、サーバーのTZに依存させない
// ・15秒×21分＝1日あたり約84レコード。1ティック1リクエストなので間引きも圧縮もしない
// ・対象銘柄は環境変数 PREMARKET_CODES で差し替える。ただし1ティックを15秒に
// 　収めるため PREMARKET_MAX（既定8）で件数に上限を掛ける

var auth = require("./auth");
var config = require("./config");
var webapi = require("./webapi");

function log() {
  var args = Array.prototype.slice.call(arguments);
  console.log.apply(console, ["[premarket]"].concat(args));
}

function warn() {
  var args = Array.prototype.slice.call(arguments);
  console.warn.apply(console, ["[premarket]"].concat(args));
}

// 「本来起きてはいけないこと」（セッションの異常終了・ティックの失敗）だけに使う。
// Railwayでは stderr が [err] に分類されるため、後から原因を拾いやすい。
function error() {
  var args = Array.prototype.slice.call(arguments);
  console.error.apply(console, ["[premarket]"].concat(args));
}

// ── 設定 ───────────────────────────────────────────────────────────────
function envStr(name, def) {
  var v = process.env[name];
  return (v == null || String(v).trim() === "") ? def : String(v).trim();
}

// 対象銘柄の既定値。PREMARKET_CODES が未設定・空文字のときはこれをそのまま使う
var DEFAULT_CODES = ["7203"];
// 1ティックあたりの銘柄数の上限（PREMARKET_MAX の既定値）
var DEFAULT_MAX_CODES = 8;

// PREMARKET_CODES を銘柄コードの配列に直す。
// ※銘柄コードには 278A のように英字を含む4桁コードがあるため、
// 　parseInt / Number / isNaN による数値判定は絶対に行わず文字列のまま扱う。
function parsePremarketCodes() {
  var raw = process.env.PREMARKET_CODES;
  if (raw == null || String(raw).trim() === "") return DEFAULT_CODES.slice();

  var invalid = [];
  var seen = {};
  var codes = [];

  String(raw)
    .replace(/["']/g, "")             // ダブルクォート・シングルクォートを全て除去
    .split(",")
    .forEach(function (part) {
      var code = String(part).trim();
      if (code === "") return;        // 空要素（連続カンマ・末尾カンマ）は捨てる
      code = code.toUpperCase();      // 278a → 278A
      if (!/^[0-9A-Z]{4}$/.test(code)) { invalid.push(code); return; }
      if (seen[code]) return;         // 重複は先に出てきた方を残す
      seen[code] = true;
      codes.push(code);               // 出現順を保持する（ソートは絶対にしない）
    });

  if (invalid.length) {
    warn("PREMARKET_CODES に4桁英数字でない値があるため除外しました:", invalid.join(","));
  }
  // 全て弾かれた場合に空配列で走ると取得そのものが壊れるため、既定値へ戻す
  if (codes.length === 0) {
    warn("PREMARKET_CODES に有効な銘柄コードが1件もないため既定値を使います");
    return DEFAULT_CODES.slice();
  }
  return codes;
}

// PREMARKET_MAX を整数として読む。未設定・不正値なら既定の8。
// （こちらは銘柄コードではなく件数なので数値として扱ってよい）
function parsePremarketMax() {
  var raw = process.env.PREMARKET_MAX;
  if (raw == null || String(raw).trim() === "") return DEFAULT_MAX_CODES;
  var s = String(raw).trim();
  if (!/^[0-9]+$/.test(s) || parseInt(s, 10) < 1) {
    warn("PREMARKET_MAX が不正なため既定値(" + DEFAULT_MAX_CODES + ")を使います:", s);
    return DEFAULT_MAX_CODES;
  }
  return parseInt(s, 10);
}

// 起動時に一度だけ確定させる。先頭から上限件数ぶんだけを採用する
// （並び順がそのまま対象銘柄の選択になるため、環境変数側で優先順に並べておくこと）
var RECEIVED_CODES = parsePremarketCodes();
var MAX_CODES = parsePremarketMax();
var CODES = RECEIVED_CODES.slice(0, MAX_CODES);

// 切り捨てログに載せる先頭の件数
var DROPPED_PREVIEW = 3;

// 上限で切り捨てた銘柄は「件数＋先頭3件＋残り件数」だけを出す。
// 全件を1行に並べると100件以上が流れてログが埋まるため。
// またこれは設定どおりの正常動作なので、Railwayで[err]扱いになる warn ではなく log で出す。
if (RECEIVED_CODES.length > CODES.length) {
  var dropped = RECEIVED_CODES.slice(MAX_CODES);
  var droppedMsg = "上限により" + dropped.length + "件を切り捨てました: " +
    dropped.slice(0, DROPPED_PREVIEW).join(",");
  if (dropped.length > DROPPED_PREVIEW) {
    droppedMsg += " ...他" + (dropped.length - DROPPED_PREVIEW) + "件";
  }
  log(droppedMsg);
}
log("対象 " + CODES.length + "件 / 受領 " + RECEIVED_CODES.length + "件 / 上限 " +
  MAX_CODES + "件 → " + CODES.join(","));

var API_BASE = envStr("VERCEL_API_BASE", "https://daytrade-simulator.vercel.app").replace(/\/+$/, "");

var START_MINUTE = 8 * 60 + 45; // 8:45:00 から
var END_MINUTE = 9 * 60 + 6;    // 9:06:00 まで
var FETCH_INTERVAL_MS = 15 * 1000;   // 取得間隔
var TICK_INTERVAL_MS = 15 * 1000;    // 窓に入ったかを15秒ごとに見る（日時判定のみ・APIは叩かない）
var POST_TIMEOUT_MS = 30 * 1000;
var POST_MAX_ATTEMPTS = 3;

// tick失敗ログは同一セッション内で先頭この件数までしか出さない。
// 立花が落ちている朝は84ティック全部が失敗しうるため、原因が分かる先頭数件だけ残す。
var TICK_ERROR_LOG_LIMIT = 3;
// エラー本文はここまでで切り捨てる（p_err に長文が入ってもログを埋めない）
var TICK_ERROR_MAX_CHARS = 200;

// ── 時刻まわり（すべてJST固定） ─────────────────────────────────────────
// UTCの現在時刻に+9時間した Date を作り、getUTC系で読むとJSTの値になる。
// サーバーのタイムゾーン設定に一切依存しない。
function nowJst() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function jstDateString() {
  return nowJst().toISOString().slice(0, 10); // YYYY-MM-DD
}

function jstMinuteOfDay(d) {
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// 土日か（祝日は判定しない。祝日に動いてもデータが空になるだけで実害はない）
function isWeekend(d) {
  var dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

// ── 取得 ───────────────────────────────────────────────────────────────
// 1回ぶんの取得。成功時は { ts, raw }、失敗時は { ts, error } を返す。
// セッションが未確立で ensureSession() が失敗した場合（8:30のメンテ明け直後など）も
// ここでerrorとして記録し、次の15秒後に自然に再試行される。
async function fetchOnce() {
  var ts = Date.now();
  try {
    var session = await auth.ensureSession();
    if (!session || !session.sUrlPrice) throw new Error("立花セッションが未確立です");
    var rows = await webapi.fetchBatchPrice(session, CODES, webapi.DEFAULT_COLS);
    return { ts: ts, raw: rows };
  } catch (e) {
    return { ts: ts, error: e.message };
  }
}

// ── ティックの失敗判定 ───────────────────────────────────────────────────
// 例外・立花のエラー応答のどちらでも、ここで必ず何らかの文字列に落とす。
// 文字列化そのものが転んでログ行を落とすことがないよう全体を try で包む。
function toText(v) {
  try {
    if (v == null) return "";
    if (typeof v === "string") return v;
    return String(v);
  } catch (e) {
    return "";
  }
}

// ログに載せる前に先頭 TICK_ERROR_MAX_CHARS 文字で切り捨てる
function truncateForLog(s) {
  var t = toText(s);
  return t.length > TICK_ERROR_MAX_CHARS ? t.slice(0, TICK_ERROR_MAX_CHARS) : t;
}

// 立花は HTTP 200 のまま本文に p_errno / p_err を載せてくる形式なので、
// 例外にならなかった応答も中身を見る（銘柄数×項目数≦200 の上限超過などを取りこぼさないため）。
// 正常形は配列だが、エラー時に応答オブジェクトがそのまま入ってくる場合も想定して両方見る。
function answerErrorReason(raw) {
  if (!raw || typeof raw !== "object") return "";

  if (Array.isArray(raw)) {
    for (var i = 0; i < raw.length; i++) {
      var nested = answerErrorReason(raw[i]);
      if (nested) return nested;
    }
    return "";
  }

  var errno = raw.p_errno == null ? "" : toText(raw.p_errno);
  var err = raw.p_err == null ? "" : toText(raw.p_err);
  if (errno !== "" && errno !== "0") {
    return "p_errno=" + errno + (err !== "" ? " p_err=" + err : "");
  }
  // p_errno が無く p_err だけ入っているケースも失敗として扱う
  if (errno === "" && err !== "" && err !== "0") return "p_err=" + err;
  return "";
}

// 1ティックが失敗していればその理由を、成功していれば "" を返す
function tickErrorReason(rec) {
  if (!rec) return "レコードなし";
  if (rec.error) return toText(rec.error) || "(エラーメッセージ取得不可)";
  return answerErrorReason(rec.raw);
}

// ── 保存（VercelのRedisへ） ─────────────────────────────────────────────
function authHeaders() {
  var h = { "Content-Type": "application/json" };
  if (config.relaySecret) h["X-Relay-Secret"] = config.relaySecret;
  return h;
}

// Vercelの上限は4.5MB。PREMARKET_MAX をどこまで上げられるかを実測で判断するため、
// 送信直前に「銘柄数 / 実バイト数 / レコード数」を出しておく。
// 文字数ではなくバイト数で測る（銘柄名などマルチバイト文字が入るため）。
function logPayloadSize(payload, body) {
  var bytes = Buffer.byteLength(body, "utf8");
  log("POST " + (payload.codes || []).length + "銘柄 / " +
    Math.round(bytes / 1024) + "KB / " + (payload.records || []).length + "レコード");
  if (bytes > 1024 * 1024) {
    warn("POSTサイズが1MBを超えました（Vercel上限4.5MB）");
  }
}

async function postLog(payload) {
  var lastError = null;
  // 本文は1回だけ作り、リトライでも同じものを使い回す（サイズ計測とも一致させる）
  var body = JSON.stringify(payload);
  logPayloadSize(payload, body);

  for (var attempt = 1; attempt <= POST_MAX_ATTEMPTS; attempt++) {
    try {
      var res = await fetch(API_BASE + "/api/sync?resource=premarket-log", {
        method: "POST",
        headers: authHeaders(),
        body: body,
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (res.status === 200) {
        log("保存しました:", payload.date, payload.records.length + "件");
        return true;
      }
      var text = "";
      try { text = await res.text(); } catch (e) { text = ""; }
      lastError = "status=" + res.status + " " + text.slice(0, 200);
    } catch (e) {
      lastError = e.message;
    }
    log("保存に失敗(" + attempt + "/" + POST_MAX_ATTEMPTS + "):", lastError);
    if (attempt < POST_MAX_ATTEMPTS) await sleep(3000 * attempt);
  }

  // 3回とも失敗した場合、せっかく貯めたデータを失わないよう全文をログに残す。
  // Railwayのログからコピーすれば手作業で復旧できる。
  log("保存に" + POST_MAX_ATTEMPTS + "回失敗したため、内容を全文出力します:");
  console.log(JSON.stringify(payload));
  return false;
}

// ── 当日ぶんの収集ループ ─────────────────────────────────────────────────
var running = false;   // セッションの多重起動防止（tick用）
var fetching = false;  // 1ティックの取得が進行中か（runSessionを直接呼ばれた場合の保険）
var lastSessionDate = null; // 収集を走らせ終えた日（JSTのYYYY-MM-DD）。同じ日に2回走らせないため

async function runSession() {
  var date = jstDateString();
  var startedAt = Date.now();
  var records = [];
  var tickErrorCount = 0; // このセッション内でティックが失敗した回数（ログの抑制と件数報告に使う）

  log("開始:", date, "対象:", CODES.join(","), "カラム:", webapi.DEFAULT_COLS);

  while (true) {
    var d = nowJst();
    if (jstDateString() !== date) break;          // 日付が変わったら終了（念のため）
    if (jstMinuteOfDay(d) >= END_MINUTE) break;   // 9:06になったら終了

    // 前のティックがまだ終わっていなければ今回は取得しない（多重起動の防止）
    if (fetching) {
      warn("前のティックが未完了のためスキップします");
      await sleep(FETCH_INTERVAL_MS);
      continue;
    }

    fetching = true;
    var rec;
    try {
      rec = await fetchOnce();
    } finally {
      fetching = false;
    }
    records.push(rec);

    // 失敗したティックは「通らなかった」ことだけでなく原因も残す。
    // ただし先頭 TICK_ERROR_LOG_LIMIT 件までで、以降は件数だけ数えて抑制する
    // （収集終了時にまとめて出す）。成功時のログは一切増やさない。
    var tickError = tickErrorReason(rec);
    if (tickError) {
      tickErrorCount++;
      if (tickErrorCount <= TICK_ERROR_LOG_LIMIT) {
        error("tick失敗: " + truncateForLog(tickError));
      }
    }

    // 1ティックの所要時間。銘柄を増やしすぎて15秒に収まらなくなったらここで気づける
    var elapsed = Date.now() - rec.ts;
    log("tick " + CODES.length + "銘柄 / " + elapsed + "ms");
    if (elapsed >= FETCH_INTERVAL_MS) {
      warn("1ティックが取得間隔(" + FETCH_INTERVAL_MS + "ms)を超えました。銘柄数を減らしてください");
    }

    // 取得にかかった時間ぶん差し引いて、15秒間隔を保つ
    var wait = FETCH_INTERVAL_MS - elapsed;
    await sleep(wait > 0 ? wait : 0);
  }

  var errorCount = records.filter(function (r) { return r.error; }).length;
  // 抑制したぶんも含めた失敗件数はここで1回だけ出す。
  // 失敗0件のときは行の内容を従来から変えない（余計な区切りも足さない）。
  var summary = records.length + "件（エラー" + errorCount + "件）";
  var elapsedSec = Math.round((Date.now() - startedAt) / 1000) + "秒";
  if (tickErrorCount > 0) {
    log("収集終了:", summary, elapsedSec, "tick失敗 " + tickErrorCount + "件");
  } else {
    log("収集終了:", summary, elapsedSec);
  }

  await postLog({
    date: date,
    codes: CODES,
    cols: webapi.DEFAULT_COLS,
    startedAt: startedAt,
    finishedAt: Date.now(),
    count: records.length,
    records: records,
  });
}

// ── 起動 ───────────────────────────────────────────────────────────────
// 収集の窓（平日の 8:45〜9:06 JST）に入っているか。
// 即時判定と毎分判定の両方から使うため関数に切り出している。
function isInWindow(d) {
  if (isWeekend(d)) return false;
  var m = jstMinuteOfDay(d);
  return m >= START_MINUTE && m < END_MINUTE;
}

// 異常終了ログ用にエラーメッセージを取り出す。
// Errorではないもの（null・文字列・オブジェクト）で reject された場合や
// message が undefined の場合でも必ず何らかの文字列を返す。
// ここで例外を出してログ行そのものを落とさないため全体を try で包む。
function errorMessage(e) {
  var msg = "";
  try {
    if (e && typeof e.message === "string" && e.message !== "") {
      msg = e.message;
    } else if (e !== null && e !== undefined) {
      msg = toText(e);
    }
  } catch (inner) {
    msg = "";
  }
  return msg !== "" ? msg : "(エラーメッセージ取得不可)";
}

// 15秒ごとに時刻を見るだけ。窓に入ったら収集ループへ入る。
// 二重起動の防止は次の2段構え。役割が違うので混ぜない。
// ・running … 収集中の再入防止。tick は setInterval のコールバックなので同期的に実行される。
// 　runSession() を呼ぶ前に同期で true にし、Promiseが決着してから false に戻すので、
// 　15秒後のtickが割り込んでも必ず true を見て即returnする。
// 　解除は必ず .finally() で行う。.then() だけだと runSession() が reject したときや
// 　catch のハンドラ自身が転んだときに false へ戻らず、running が true のまま固着して
// 　翌営業日以降も窓の頭で即returnし続ける（再デプロイするまで無言でデータが取れない）。
// ・lastSessionDate … 同一日の再突入防止。その日ぶんを走らせ終えたら日付を記録し、
// 　同じ日は二度と入らない。窓の終了(9:06)で抜けた後だけでなく、runSessionが即座に
// 　落ちた場合でも15秒ごとに再突入を繰り返さない（＝異常終了時は本日分を諦める）。
function tick() {
  if (running) return;
  if (!isInWindow(nowJst())) return;

  var date = jstDateString();
  if (lastSessionDate === date) return; // 当日ぶんは収集済み

  running = true;
  runSession()
    .catch(function (e) {
      // 途中で落ちた場合は方針どおり本日分を諦めるが、黙って諦めると
      // 翌朝データが無い理由が分からなくなるため必ず1行残す。
      error("セッション異常終了。本日分（" + date + "）は中止します: " + errorMessage(e));
    })
    .finally(function () {
      // 成功・失敗のどちらでも必ずここを通す（.then() では reject 時に発火しない）。
      lastSessionDate = date; // 同一日の再突入ガード（従来どおりの挙動）
      running = false;        // 翌営業日の窓では通常どおり開始できる
    });
}

function start() {
  log("起動しました。8:45〜9:06(JST/平日) に15秒間隔で取得します。宛先:", API_BASE);

  // 窓に入ったかの判定。窓外からの通常の開始はこちらが担当する。
  // 60秒間隔だとコンテナの起動秒数によって窓の頭が最大59秒欠測していたため、
  // 収集間隔と同じ15秒まで縮めて検知遅れを最大1ティックぶんに抑える。
  // 窓外で走るのは日時計算だけで、立花APIへのアクセスは一切発生しない。
  setInterval(tick, TICK_INTERVAL_MS);

  // 起動が窓の途中だった場合、次の判定まで待つとそのぶん取り逃す。
  // 判定間隔を待たず、その場で1回だけ判定して即座に収集を始める。
  if (isInWindow(nowJst())) {
    log("起動時に窓内のため即時開始します");
    tick();
  } else {
    log("起動時は窓外です。8:45を待機します");
  }
}

// runSession は動作確認用に公開している（通常は tick からのみ呼ばれる）
module.exports = { start: start, runSession: runSession };
