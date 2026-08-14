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
// ・15秒×21分＝1日あたり約84レコード。1銘柄なら十分軽いので間引きも圧縮もしない

var auth = require("./auth");
var config = require("./config");
var webapi = require("./webapi");

function log() {
  var args = Array.prototype.slice.call(arguments);
  console.log.apply(console, ["[premarket]"].concat(args));
}

// ── 設定 ───────────────────────────────────────────────────────────────
function envStr(name, def) {
  var v = process.env[name];
  return (v == null || String(v).trim() === "") ? def : String(v).trim();
}

// 対象銘柄（カンマ区切り）。未設定ならトヨタ1銘柄だけを見る
var CODES = envStr("PREMARKET_CODES", "7203")
  .split(",")
  .map(function (c) { return c.trim(); })
  .filter(Boolean);

var API_BASE = envStr("VERCEL_API_BASE", "https://daytrade-simulator.vercel.app").replace(/\/+$/, "");

var START_MINUTE = 8 * 60 + 45; // 8:45:00 から
var END_MINUTE = 9 * 60 + 6;    // 9:06:00 まで
var FETCH_INTERVAL_MS = 15 * 1000;   // 取得間隔
var TICK_INTERVAL_MS = 60 * 1000;    // 時間外は1分ごとに時刻だけ見る
var POST_TIMEOUT_MS = 30 * 1000;
var POST_MAX_ATTEMPTS = 3;

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

// ── 保存（VercelのRedisへ） ─────────────────────────────────────────────
function authHeaders() {
  var h = { "Content-Type": "application/json" };
  if (config.relaySecret) h["X-Relay-Secret"] = config.relaySecret;
  return h;
}

async function postLog(payload) {
  var lastError = null;
  for (var attempt = 1; attempt <= POST_MAX_ATTEMPTS; attempt++) {
    try {
      var res = await fetch(API_BASE + "/api/sync?resource=premarket-log", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(payload),
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
var running = false;

async function runSession() {
  var date = jstDateString();
  var startedAt = Date.now();
  var records = [];

  log("開始:", date, "対象:", CODES.join(","), "カラム:", webapi.DEFAULT_COLS);

  while (true) {
    var d = nowJst();
    if (jstDateString() !== date) break;          // 日付が変わったら終了（念のため）
    if (jstMinuteOfDay(d) >= END_MINUTE) break;   // 9:06になったら終了

    var rec = await fetchOnce();
    records.push(rec);

    // 取得にかかった時間ぶん差し引いて、15秒間隔を保つ
    var wait = FETCH_INTERVAL_MS - (Date.now() - rec.ts);
    await sleep(wait > 0 ? wait : 0);
  }

  var errorCount = records.filter(function (r) { return r.error; }).length;
  log("収集終了:", records.length + "件（エラー" + errorCount + "件）",
    Math.round((Date.now() - startedAt) / 1000) + "秒");

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

// 時間外は1分ごとに時刻を見るだけ。窓に入ったら収集ループへ入る。
// running フラグで多重起動を防ぐ（起動直後の即時開始と毎分判定が重ならないように）。
function tick() {
  if (running) return;
  if (!isInWindow(nowJst())) return;

  running = true;
  runSession()
    .catch(function (e) { log("予期しないエラー:", e.message); })
    .then(function () { running = false; });
}

function start() {
  log("起動しました。8:45〜9:06(JST/平日) に15秒間隔で取得します。宛先:", API_BASE);

  // 毎分の判定。窓外からの通常の開始はこちらが担当する。
  setInterval(tick, TICK_INTERVAL_MS);

  // 起動が窓の途中だった場合、次の分境界まで待つと最大60秒ぶん取り逃す。
  // 分境界を待たず、その場で1回だけ判定して即座に収集を始める。
  if (isInWindow(nowJst())) {
    log("起動時に窓内のため即時開始します");
    tick();
  } else {
    log("起動時は窓外です。8:45を待機します");
  }
}

// runSession は動作確認用に公開している（通常は tick からのみ呼ばれる）
module.exports = { start: start, runSession: runSession };
