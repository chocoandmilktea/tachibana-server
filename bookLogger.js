// tachibana-server/bookLogger.js
// 場中の板情報を1分おきに記録し、daytrade-data リポジトリへ1時間ごとの CSV.gz として保存する。
//
// 【目的】
// 30営業日ほど貯めてから「1分後・5分後・30分後に上がっているか」との関係を検証するための記録。
// 売買にも画面表示にも使わない。立花の応答は加工せずそのまま書く（後から何が取れていたかを検証するため）。
//
// 【動き方】
// ・node-cron で毎分起動し、平日 9:00〜11:30 と 12:30〜15:30（両端を含む）だけ取得する。休場日は holidays.js で飛ばす
// ・毎分 1m 用の項目（FRONT_COLS）、5分の区切り（9:00, 9:05…）だけは 5m 用の項目（FULL_COLS）で1回だけ問い合わせ、
// 　その結果から 1m と 5m の両方の行を作る
// ・対象は「前営業日 15:35 時点の売買代金上位500銘柄」。リストは daytrade-data の data/book/targets に保存する
// ・保存は GitHub の Contents API。同じパスに既にファイルがあれば書かない（書き換えない決まり）
//
// 【守ること】
// ・ログは console.log だけ。Railway では console.warn も [err] に分類され、正常系が障害ログに混ざるため
// ・立花への問い合わせは100銘柄ずつ・直列。並列にすると p_no の到着順が入れ替わり p_errno=6 で弾かれる
// ・ログイン（login / reLogin）はこのファイルから呼ばない。セッション切れの扱いは auth.request に任せる

var zlib = require("zlib");
var util = require("util");
var cron = require("node-cron");
var auth = require("./auth");
var webapi = require("./webapi");
var holidays = require("./holidays");

var gzip = util.promisify(zlib.gzip);

function log() {
  var args = Array.prototype.slice.call(arguments);
  console.log.apply(console, ["[book]"].concat(args));
}

// ── 設定 ───────────────────────────────────────────────────────────────
function envStr(name, def) {
  var v = process.env[name];
  return (v == null || String(v).trim() === "") ? def : String(v).trim();
}

// Railwayのサーバー時刻はUTCのため、タイムゾーンは必ず明示する（省略すると9時間ずれる）
var TZ = "Asia/Tokyo";
var GITHUB_TOKEN = envStr("BOOK_GITHUB_TOKEN", "");
var GITHUB_REPO = envStr("BOOK_GITHUB_REPO", "chocoandmilktea/daytrade-data");
var GITHUB_TIMEOUT_MS = 15 * 1000; // GitHub への通信1回あたりの上限

// 立花の時価情報は1要求につき先頭120件までしか返さず、121件目以降は黙って捨てられる
// （削除済みの premarketLogger.js で実測）。上限に余裕を持たせて100件ずつに割る
var CHUNK_SIZE = 100;
var TARGET_COUNT = 500; // 記録対象にする売買代金上位の銘柄数

// 記録する時間帯（JSTの0時からの分。両端を含む）
var SESSIONS = [
  [9 * 60, 11 * 60 + 30],       // 前場 9:00〜11:30
  [12 * 60 + 30, 15 * 60 + 30], // 後場 12:30〜15:30
];
var SELECT_MINUTE = 15 * 60 + 35;  // 翌営業日の対象を選ぶ時刻
var DISCARD_MINUTE = 16 * 60;      // この時刻になっても書けなかったファイルは破棄する
// 対象選定は全銘柄（約3,700件）を37回に分けて問い合わせるため、失敗時は間を空け回数も絞る
var SELECT_RETRY_GAP_MS = 10 * 60 * 1000;
var SELECT_MAX_ATTEMPTS = 6;

var LOG_PREVIEW = 10;        // 欠けた銘柄コードをログに並べる件数
var ERROR_MAX_CHARS = 200;   // エラー本文をログに載せる最大文字数

// ── 記録する項目 ─────────────────────────────────────────────────────────
// 立花の EVENT I/F 資料の情報コード。問い合わせ時は値に p、時刻に t を付ける（例: pGAP1, tDPP:T）
function numbered(prefix) {
  var out = [];
  for (var i = 1; i <= 10; i++) out.push(prefix + i);
  return out;
}

function queryName(item) {
  return (/:T$/.test(item) ? "t" : "p") + item;
}

// 5分おき（ファイル種別 5m）
var FULL_ITEMS = [
  // 値動き
  "DPP", "DPP:T", "PRP", "DOP", "DHP", "DLP", "DV", "DJ", "VWAP",
  // 板の手前
  "QAP", "QAS", "AV", "QBP", "QBS", "BV", "AAV", "ABV", "QOV", "QUV",
].concat(numbered("GAP"), numbered("GAV"), numbered("GBP"), numbered("GBV")); // 板の奥

// 1分おき（ファイル種別 1m）
var FRONT_ITEMS = [
  "DPP", "DPP:T", "DV", "DJ", "VWAP",
  "QAP", "QAS", "AV", "QBP", "QBS", "BV", "AAV", "ABV", "QOV", "QUV",
];

var FULL_COLS = FULL_ITEMS.map(queryName);
var FRONT_COLS = FRONT_ITEMS.map(queryName);
// 全項目での問い合わせがエラーになったときに、その回だけ切り替える16項目
var FALLBACK_COLS = [
  "pDPP", "pPRP", "pDV", "pDOP", "pDHP", "pDLP", "pQAS", "pQBS",
  "pAAV", "pABV", "pGAP1", "pGBP1", "pGAV1", "pGBV1", "pQOV", "pQUV",
];
var COL_SETS = { full: FULL_COLS, front: FRONT_COLS, fallback16: FALLBACK_COLS };
// ファイル種別ごとのCSVの項目列。fallback16 で取った行も同じ列に並べ、取れなかった項目は空にする
var KIND_COLS = { "1m": FRONT_COLS, "5m": FULL_COLS };

// ── 時刻まわり（すべてJST固定） ─────────────────────────────────────────
// UTCの現在時刻に+9時間した Date を getUTC系で読むとJSTの値になる。サーバーのTZに依存しない
function pad2(n) {
  return String(n).padStart(2, "0");
}

function clock(ms) {
  var t = ms == null ? Date.now() : ms;
  var d = new Date(t + 9 * 60 * 60 * 1000);
  var hh = d.getUTCHours();
  var mm = d.getUTCMinutes();
  return {
    ms: t,
    date: d.toISOString().slice(0, 10), // YYYY-MM-DD
    hh: hh,
    mm: mm,
    mod: hh * 60 + mm, // 0時からの分
    hhmm: pad2(hh) + ":" + pad2(mm),
    hms: pad2(hh) + ":" + pad2(mm) + ":" + pad2(d.getUTCSeconds()),
    iso: d.toISOString().slice(0, 19) + "+09:00",
  };
}

function isCollectMinute(mod) {
  return SESSIONS.some(function (s) { return mod >= s[0] && mod <= s[1]; });
}

// その時のうち、前場・後場の終わり（11:30・15:30）が含まれる時なら終わりの分を返す。無ければ null
function sessionEndInHour(hour) {
  for (var i = 0; i < SESSIONS.length; i++) {
    if (Math.floor(SESSIONS[i][1] / 60) === hour) return SESSIONS[i][1];
  }
  return null;
}

function isBusinessDay(date) {
  return !holidays.isMarketClosed(date);
}

// 翌営業日（休場日を飛ばす）。連休でも30日先までに見つからなければ null
function nextBusinessDay(date) {
  var t = new Date(date + "T00:00:00Z").getTime();
  for (var i = 1; i <= 30; i++) {
    var s = new Date(t + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (isBusinessDay(s)) return s;
  }
  return null;
}

// ── 小物 ───────────────────────────────────────────────────────────────
function errorMessage(e) {
  var msg = "";
  try {
    msg = e && typeof e.message === "string" && e.message !== "" ? e.message : String(e);
  } catch (inner) {
    msg = "";
  }
  if (!msg) msg = "(エラーメッセージ取得不可)";
  return msg.length > ERROR_MAX_CHARS ? msg.slice(0, ERROR_MAX_CHARS) : msg;
}

function chunk(arr, size) {
  var out = [];
  for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// 銘柄コードは 278A のような英字入りがあるため、数値に変換せず文字列のまま大文字にそろえる
function normCode(v) {
  return String(v == null ? "" : v).trim().toUpperCase();
}

// 要求したのに応答に1行も出てこなかった銘柄コード。
// 応答の並びが要求順と一致する保証は無いため、位置ではなく銘柄コードの集合で突き合わせる
function missingCodes(requested, rows) {
  var seen = {};
  rows.forEach(function (r) { if (r) seen[normCode(r.sIssueCode)] = true; });
  return requested.filter(function (c) { return !seen[normCode(c)]; });
}

function previewCodes(codes) {
  var s = codes.slice(0, LOG_PREVIEW).join(",");
  return codes.length > LOG_PREVIEW ? s + " ...他" + (codes.length - LOG_PREVIEW) + "件" : s;
}

function csvCell(v) {
  if (v == null) return "";
  var s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csvLine(cells) {
  return cells.map(csvCell).join(",");
}

// ── GitHub（Contents API） ──────────────────────────────────────────────
function contentsUrl(path) {
  return "https://api.github.com/repos/" + GITHUB_REPO + "/contents/" +
    path.split("/").map(encodeURIComponent).join("/");
}

function githubFetch(method, path, body) {
  return fetch(contentsUrl(path), {
    method: method,
    headers: {
      "Authorization": "Bearer " + GITHUB_TOKEN,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "tachibana-server-bookLogger",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    // 本文の読み込みにも同じ期限が効く
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
}

async function readText(res) {
  try { return await res.text(); } catch (e) { return ""; }
}

// ファイルを取得する。無ければ null。それ以外の失敗は例外
async function getFile(path) {
  var res = await githubFetch("GET", path);
  if (res.status === 404) { await readText(res); return null; }
  var text = await readText(res);
  if (res.status !== 200) throw new Error("GitHub GET status=" + res.status + " " + text.slice(0, ERROR_MAX_CHARS));
  var json = JSON.parse(text);
  return Buffer.from(json.content || "", "base64");
}

// 新規作成だけを行う。sha を渡さないため、既にあるファイルは GitHub 側が 422 で拒否する（上書きされない）。
// 戻り値は "created" / "exists"。それ以外の失敗は例外（呼び出し側で次の回に再試行する）
async function createFile(path, buf, message) {
  var res = await githubFetch("PUT", path, { message: message, content: buf.toString("base64") });
  var text = await readText(res);
  if (res.status === 201) return "created";
  if (res.status === 422) {
    // 422 は「既にある」以外の入力エラーでも返るため、実際にあるかを確かめてから既存扱いにする
    if (await getFile(path)) return "exists";
  }
  throw new Error("GitHub PUT status=" + res.status + " " + text.slice(0, ERROR_MAX_CHARS));
}

function bookPath(kind, date, hour) {
  return "data/book/" + kind + "/" + date.slice(0, 4) + "/" + date + "/" + pad2(hour) + ".csv.gz";
}

function targetsPath(date) {
  return "data/book/targets/" + date.slice(0, 4) + "/" + date + ".csv";
}

// ── 対象銘柄リスト ──────────────────────────────────────────────────────
// targets[日付] = { date, method, selectedAt, rows: [{code, dj, rank}], codes: [...], saved }
var targets = {};
// 選定の再試行の間隔と回数を、対象日ごとに覚える
var selectAttempts = {}; // 日付 -> { count, nextAt }

var TARGET_HEADER = ["code", "dj", "rank", "selected_at", "method"];

function targetsCsv(entry) {
  var lines = [csvLine(TARGET_HEADER)];
  entry.rows.forEach(function (r) {
    lines.push(csvLine([r.code, r.dj, r.rank, entry.selectedAt, entry.method]));
  });
  return lines.join("\n") + "\n";
}

// 対象リストのCSVを読む。値に , や " は入らない（銘柄コード・数値・時刻・選び方のみ）ため単純に分割する
function parseTargetsCsv(date, text) {
  var lines = String(text).split(/\r?\n/).filter(function (l) { return l.trim() !== ""; });
  if (lines.length < 2) return null;
  var head = lines[0].split(",");
  var iCode = head.indexOf("code");
  var iDj = head.indexOf("dj");
  var iRank = head.indexOf("rank");
  var iAt = head.indexOf("selected_at");
  var iMethod = head.indexOf("method");
  if (iCode < 0) return null;
  var rows = lines.slice(1).map(function (l) {
    var c = l.split(",");
    return { code: normCode(c[iCode]), dj: iDj >= 0 ? c[iDj] : "", rank: iRank >= 0 ? c[iRank] : "" };
  }).filter(function (r) { return r.code; });
  if (!rows.length) return null;
  var first = lines[1].split(",");
  return {
    date: date,
    method: iMethod >= 0 ? first[iMethod] : "",
    selectedAt: iAt >= 0 ? first[iAt] : "",
    rows: rows,
    codes: rows.map(function (r) { return r.code; }),
    saved: true,
  };
}

// daytrade-data から読み戻す。戻り値の status は "found" / "notfound" / "error"
async function loadTargets(date) {
  try {
    var buf = await getFile(targetsPath(date));
    if (!buf) return { status: "notfound" };
    var entry = parseTargetsCsv(date, buf.toString("utf8"));
    if (!entry) return { status: "error", message: "対象リストのCSVを解釈できません: " + targetsPath(date) };
    return { status: "found", entry: entry };
  } catch (e) {
    return { status: "error", message: errorMessage(e) };
  }
}

async function saveTargets(entry) {
  try {
    var result = await createFile(targetsPath(entry.date), Buffer.from(targetsCsv(entry), "utf8"),
      "book: targets " + entry.date + "（" + entry.rows.length + "銘柄・" + entry.method + "）");
    entry.saved = true;
    if (result === "exists") {
      log("対象リストは既にあるため書きません（メモリ上のリストで記録を続けます）:", targetsPath(entry.date));
    } else {
      log("対象リストを保存しました:", targetsPath(entry.date), entry.rows.length + "銘柄", entry.method);
    }
  } catch (e) {
    // メモリには残っているので記録は続く。保存は次の回に再試行する
    log("対象リストの保存に失敗しました（次の回に再試行します）:", targetsPath(entry.date), errorMessage(e));
  }
}

// 1回分の問い合わせ。セッションは毎回 ensureSession から取り直す。
// auth.request が p_errno=2 を検知して再ログインすると仮想URLが新しくなるため、古い session を
// 使い回すと後続の要求が毎回 p_errno=2 になり、再ログインを繰り返させてしまう
// セッションを用意できなかった失敗には sessionError を付ける（項目を切り替えても無駄なため回ごと中止する）
async function fetchChunk(codes, cols) {
  var session;
  try {
    session = await auth.ensureSession();
  } catch (e) {
    var err = new Error("立花セッションを用意できません: " + errorMessage(e));
    err.sessionError = true;
    throw err;
  }
  var rows = await webapi.fetchBatchPrice(session, codes, cols.join(","));
  return Array.isArray(rows) ? rows : [];
}

// 全銘柄の売買代金(pDJ)を取り、上位 TARGET_COUNT 銘柄を選ぶ。method は選び方の記録
//   after_close … 前営業日 15:35 以降の売買代金で選んだ（通常）
//   intraday    … 場中に起動してリストがどこにも無かったため、その時点の売買代金で選んだ
async function selectTargets(date, method) {
  var startedAt = Date.now();
  var master = await webapi.getRankingMaster();
  var codes = master.map(function (i) { return normCode(i.sIssueCode); }).filter(Boolean);
  var groups = chunk(codes, CHUNK_SIZE);
  var rows = [];
  var missing = [];
  // 1つでも失敗したら選定そのものを失敗にする（欠けたまま選ぶと上位500が歪むため）
  for (var i = 0; i < groups.length; i++) {
    var part = await fetchChunk(groups[i], ["pDJ", "pDPP"]);
    missing = missing.concat(missingCodes(groups[i], part));
    rows = rows.concat(part);
  }
  if (missing.length) {
    log("選定: 件数不一致 要求" + codes.length + "件 / 応答" + rows.length + "件 欠け: " + previewCodes(missing));
  }

  var ranked = rows.map(function (r) {
    return { code: normCode(r.sIssueCode), djText: r.pDJ == null ? "" : String(r.pDJ), dj: parseFloat(r.pDJ) };
  }).filter(function (r) {
    // 売買の無い銘柄（売買代金0・空）は順位を付けられないため外す
    return r.code && isFinite(r.dj) && r.dj > 0;
  });
  ranked.sort(function (a, b) { return b.dj - a.dj; });
  ranked = ranked.slice(0, TARGET_COUNT);
  if (!ranked.length) throw new Error("売買代金の取れた銘柄が0件です（対象 " + codes.length + " 銘柄）");

  var entry = {
    date: date,
    method: method,
    selectedAt: clock().iso,
    rows: ranked.map(function (r, idx) { return { code: r.code, dj: r.djText, rank: idx + 1 }; }),
    saved: false,
  };
  entry.codes = entry.rows.map(function (r) { return r.code; });
  log("対象を選定しました:", date, entry.rows.length + "銘柄", method,
    "（全" + codes.length + "銘柄・" + ((Date.now() - startedAt) / 1000).toFixed(1) + "秒）");
  return entry;
}

// 選定の再試行を間引く。許可されれば true
function canAttemptSelect(date) {
  var a = selectAttempts[date];
  if (!a) return true;
  return a.count < SELECT_MAX_ATTEMPTS && Date.now() >= a.nextAt;
}

function markSelectFailed(date, e) {
  var a = selectAttempts[date] || { count: 0, nextAt: 0 };
  a.count += 1;
  a.nextAt = Date.now() + SELECT_RETRY_GAP_MS;
  selectAttempts[date] = a;
  var tail = a.count >= SELECT_MAX_ATTEMPTS
    ? "（" + a.count + "回失敗したため、この日の選定は諦めます）"
    : "（" + a.count + "/" + SELECT_MAX_ATTEMPTS + "回目。" + SELECT_RETRY_GAP_MS / 60000 + "分後に再試行します）";
  log("対象の選定に失敗しました:", date, errorMessage(e), tail);
}

async function selectAndSave(date, method) {
  if (!canAttemptSelect(date)) return null;
  try {
    var entry = await selectTargets(date, method);
    targets[date] = entry;
    await saveTargets(entry);
    return entry;
  } catch (e) {
    markSelectFailed(date, e);
    return null;
  }
}

// その日のリストを用意する。メモリ → daytrade-data の順に探し、
// allowIntraday のとき（場中）だけ、どこにも無ければその時点の売買代金で選ぶ
async function ensureTodayTargets(c, allowIntraday) {
  if (targets[c.date]) return targets[c.date];
  var loaded = await loadTargets(c.date);
  if (loaded.status === "found") {
    targets[c.date] = loaded.entry;
    log("対象リストを読み戻しました:", targetsPath(c.date), loaded.entry.codes.length + "銘柄", loaded.entry.method);
    return loaded.entry;
  }
  if (loaded.status === "error") {
    // 読めなかっただけで実在する可能性があるため、ここでは選び直さない（次の回に読み直す）
    log("対象リストを読み戻せませんでした（" + c.hhmm + "）:", loaded.message);
    return null;
  }
  if (!allowIntraday || !canAttemptSelect(c.date)) return null;
  log("対象リストがどこにも無いため、現時点の売買代金で選定します（method=intraday）:", c.date);
  return selectAndSave(c.date, "intraday");
}

// 15:35 以降、翌営業日のリストを用意する。メモリ → daytrade-data の順に探し、無ければ選ぶ
async function ensureNextDayTargets(c) {
  var next = nextBusinessDay(c.date);
  if (!next || targets[next]) return;
  if (!canAttemptSelect(next)) return;
  var loaded = await loadTargets(next);
  if (loaded.status === "found") {
    targets[next] = loaded.entry;
    log("翌営業日の対象リストは既にあります:", targetsPath(next), loaded.entry.codes.length + "銘柄");
    return;
  }
  if (loaded.status === "error") {
    // 読めない間は選ばない（既にある可能性があるため）。毎分読み直すだけなので立花への負荷は無い
    log("翌営業日の対象リストを確認できませんでした:", loaded.message);
    return;
  }
  await selectAndSave(next, "after_close");
}

// 保存に失敗したリストを再試行する。対象日を過ぎたものと古いものはメモリから消す
async function maintainTargets(c) {
  var dates = Object.keys(targets);
  for (var i = 0; i < dates.length; i++) {
    var entry = targets[dates[i]];
    if (dates[i] < c.date) { delete targets[dates[i]]; continue; }
    if (!entry.saved) await saveTargets(entry);
  }
  Object.keys(selectAttempts).forEach(function (d) { if (d < c.date) delete selectAttempts[d]; });
}

// ── 書き出し待ちのバッファ ─────────────────────────────────────────────
// buffers[パス] = 書き込み中の時の行（まだその時の回が続く）
// pending       = 時が閉じて書き出しを待っているファイル（失敗したものも次の回まで残る）
var buffers = {};
var pending = [];

function appendLines(kind, date, hour, lines) {
  if (!lines.length) return;
  var path = bookPath(kind, date, hour);
  var b = buffers[path];
  if (!b) b = buffers[path] = { kind: kind, date: date, hour: hour, path: path, lines: [] };
  for (var i = 0; i < lines.length; i++) b.lines.push(lines[i]);
}

// 時が変わったら前の時の分を、11:30 と 15:30 の回の後はその時の分を、書き出し待ちへ移す。
// afterRun は「c の回の取得を終えた後か」。11:30 の回の開始時に閉じると 11:30 の行が入らないため、
// 開始時は終わりの分を過ぎてから（11:30 の回が飛ばされたとき）だけ閉じる
function closeBuffers(c, afterRun) {
  Object.keys(buffers).forEach(function (path) {
    var b = buffers[path];
    var end = sessionEndInHour(b.hour);
    var endPassed = end !== null && (afterRun ? c.mod >= end : c.mod > end);
    var closed = b.date !== c.date || b.hour !== c.hh || endPassed;
    if (!closed) return;
    pending.push(b);
    delete buffers[path];
  });
}

// その日の 16:00 になっても書けなかったもの（と日付をまたいだもの）は破棄する
function discardExpired(c) {
  pending = pending.filter(function (p) {
    if (p.date === c.date && c.mod < DISCARD_MINUTE) return true;
    log("書き出せなかったため破棄します:", p.path, p.lines.length + "行");
    stats.discarded += 1;
    return false;
  });
}

async function flushPending() {
  var rest = [];
  for (var i = 0; i < pending.length; i++) {
    var p = pending[i];
    try {
      var header = csvLine(["time", "code", "cols"].concat(KIND_COLS[p.kind]));
      var buf = await gzip(Buffer.from(header + "\n" + p.lines.join("\n") + "\n", "utf8"));
      var result = await createFile(p.path, buf,
        "book: " + p.kind + " " + p.date + " " + pad2(p.hour) + "時（" + p.lines.length + "行）");
      if (result === "exists") {
        log("同じパスに既にファイルがあるため書きません:", p.path);
      } else {
        stats.files.push(p.kind + "/" + pad2(p.hour));
      }
    } catch (e) {
      // メモリに残し、次の回に再試行する
      stats.writeErrors += 1;
      log("書き出しに失敗しました（次の回に再試行します）:", p.path, errorMessage(e));
      rest.push(p);
    }
  }
  pending = rest;
}

// ── 1時間ごとの要約 ────────────────────────────────────────────────────
function newStats(key) {
  return {
    key: key, runs: 0, rows: 0, skipped: 0, fallbackRuns: 0, mismatchRuns: 0,
    failedRuns: 0, files: [], writeErrors: 0, discarded: 0,
  };
}

var stats = newStats("");

// 正常時は1時間に1行だけ出す。何も起きなかった時（時間外）は出さない
function rollStats(c) {
  var key = c.date + " " + pad2(c.hh) + "時";
  if (stats.key === key) return;
  var s = stats;
  stats = newStats(key);
  if (!s.key) return;
  if (!s.runs && !s.skipped && !s.failedRuns && !s.files.length && !s.writeErrors && !s.discarded) return;
  log("要約 " + s.key + ": " + s.runs + "回 / 平均" + (s.runs ? (s.rows / s.runs).toFixed(1) : "0") + "件" +
    " / 飛ばし" + s.skipped + "回 / 取得失敗" + s.failedRuns + "回 / fallback16 " + s.fallbackRuns + "回" +
    " / 件数不一致" + s.mismatchRuns + "回 / 書き出し " + (s.files.length ? s.files.join(",") : "なし") +
    (s.writeErrors ? " / 書き出し失敗" + s.writeErrors + "回" : "") +
    (s.discarded ? " / 破棄" + s.discarded + "件" : ""));
}

// ── 1回分の取得 ───────────────────────────────────────────────────────
// 起動後に各項目セットを初めて使った回だけ、全銘柄で空だった項目名を出す
var emptyReported = {};
// 欠けた銘柄の組み合わせが前回と同じなら詳細は出さない（上場廃止などで毎分同じ行が並ぶのを防ぐ）
var lastMissingKey = "";

function reportEmptyColumns(mode, rows) {
  if (emptyReported[mode] || !rows.length) return;
  emptyReported[mode] = true;
  var empty = COL_SETS[mode].filter(function (col) {
    return rows.every(function (r) { return r[col] == null || String(r[col]).trim() === ""; });
  });
  log("全銘柄で空だった項目（" + mode + "・" + rows.length + "銘柄）: " + (empty.length ? empty.join(",") : "なし"));
}

// codes を100件ずつ直列で問い合わせる。primary（full か front）がエラーになったら、
// その回の残りは fallback16 に切り替えて記録を続ける
async function fetchRun(c, codes, primary) {
  var mode = primary;
  var items = []; // { time, mode, row }
  var missing = [];
  var groups = chunk(codes, CHUNK_SIZE);
  var failedGroups = 0;

  for (var i = 0; i < groups.length; i++) {
    var group = groups[i];
    var time = clock().hms;
    var part;
    try {
      part = await fetchChunk(group, COL_SETS[mode]);
    } catch (e) {
      if (e.sessionError) {
        failedGroups += groups.length - i;
        log(c.hhmm + " この回の取得を中止します:", errorMessage(e));
        break;
      }
      if (mode === "fallback16") {
        failedGroups++;
        log(c.hhmm + " 問い合わせ失敗（fallback16・" + (i + 1) + "/" + groups.length + "）:", errorMessage(e));
        continue;
      }
      log(c.hhmm + " " + mode + " での問い合わせがエラーのため、この回は fallback16 に切り替えます（" +
        (i + 1) + "/" + groups.length + "）:", errorMessage(e));
      mode = "fallback16";
      time = clock().hms;
      try {
        part = await fetchChunk(group, FALLBACK_COLS);
      } catch (e2) {
        if (e2.sessionError) {
          failedGroups += groups.length - i;
          log(c.hhmm + " この回の取得を中止します:", errorMessage(e2));
          break;
        }
        failedGroups++;
        log(c.hhmm + " 問い合わせ失敗（fallback16・" + (i + 1) + "/" + groups.length + "）:", errorMessage(e2));
        continue;
      }
    }
    missing = missing.concat(missingCodes(group, part));
    part.forEach(function (row) { items.push({ time: time, mode: mode, row: row }); });
  }
  return { items: items, missing: missing, failedGroups: failedGroups, groups: groups.length, fellBack: mode !== primary };
}

function bookLine(item, cols) {
  return csvLine([item.time, normCode(item.row.sIssueCode), item.mode].concat(cols.map(function (col) {
    var v = item.row[col];
    return v == null ? "" : v;
  })));
}

async function collect(c) {
  var entry = await ensureTodayTargets(c, true);
  if (!entry) {
    stats.failedRuns += 1;
    return;
  }

  // 5分の区切りは 5m 用の項目で1回だけ問い合わせ、その結果から 1m と 5m の両方の行を作る
  var isFive = c.mm % 5 === 0;
  var res = await fetchRun(c, entry.codes, isFive ? "full" : "front");

  stats.runs += 1;
  stats.rows += res.items.length;
  if (res.fellBack) stats.fallbackRuns += 1;
  if (res.failedGroups === res.groups) stats.failedRuns += 1;

  // 要求と応答の件数照合。取れなかったグループの銘柄は失敗として別に出しているのでここには含めない
  if (res.missing.length) {
    stats.mismatchRuns += 1;
    var key = res.missing.join(",");
    if (key !== lastMissingKey) {
      log(c.hhmm + " 件数不一致 要求" + entry.codes.length + "件 / 応答" + res.items.length + "件 欠け: " +
        previewCodes(res.missing));
    }
    lastMissingKey = key;
  } else {
    lastMissingKey = "";
  }

  var byMode = {};
  res.items.forEach(function (it) { (byMode[it.mode] = byMode[it.mode] || []).push(it.row); });
  Object.keys(byMode).forEach(function (mode) { reportEmptyColumns(mode, byMode[mode]); });

  // 時のファイルは「回の時刻」で決める（11:30 の回は 11、15:30 の回は 15）
  appendLines("1m", c.date, c.hh, res.items.map(function (it) { return bookLine(it, FRONT_COLS); }));
  if (isFive) appendLines("5m", c.date, c.hh, res.items.map(function (it) { return bookLine(it, FULL_COLS); }));
}

// ── 毎分の処理 ─────────────────────────────────────────────────────────
var running = false;
var lastRunKey = ""; // 同じ分に2回走らせないため

async function runTick(c) {
  closeBuffers(c, false);
  discardExpired(c);

  var business = isBusinessDay(c.date);
  var runKey = c.date + " " + c.hhmm;
  if (business && isCollectMinute(c.mod) && lastRunKey !== runKey) {
    lastRunKey = runKey;
    await collect(c);
  }

  // 書き出しは取得の後に行う（取得の開始を遅らせないため）。失敗分の再試行もここで行う。
  // 閉じる判定は「この回が始まった時刻」c で行い、取得後の時計では判定しない。
  // 11:29 の回が 11:30 を過ぎて終わったときに時計で判定すると、11:30 の回より前に 11時のファイルを
  // 閉じてしまい、続く 11:30 の回の行が「同じパスに既にある」扱いで捨てられるため
  closeBuffers(c, true);
  if (pending.length) await flushPending();

  await maintainTargets(c);
  if (business && c.mod >= SELECT_MINUTE) await ensureNextDayTargets(c);
}

// 前の回が終わっていなければ、その回は飛ばす。
// running の解除は必ず finally で行う。.then() や catch の中だと、処理が reject したときや
// catch 自身が転んだときに解除されず、以後ずっと全ての回を飛ばし続ける（再起動まで無言で記録が止まる）
function guarded(label, fn) {
  var c = clock();
  rollStats(c);
  if (running) {
    if (isBusinessDay(c.date) && isCollectMinute(c.mod)) {
      stats.skipped += 1;
      log("前の回が終わっていないため " + c.hhmm + " の回を飛ばします");
    }
    return Promise.resolve();
  }
  running = true;
  return Promise.resolve()
    .then(function () { return fn(c); })
    .catch(function (e) { log(label + " で想定外のエラー:", errorMessage(e)); })
    .finally(function () { running = false; });
}

function tick() {
  return guarded("毎分の処理", runTick);
}

// 起動時: その日のリストを daytrade-data から読み戻す。15:35 より後なら翌営業日のリストも用意する
function startup(c) {
  return (async function () {
    if (!isBusinessDay(c.date)) return;
    var entry = await ensureTodayTargets(c, false);
    if (!entry && !isCollectMinute(c.mod) && c.mod < SESSIONS[0][0]) {
      log("本日の対象リストはまだありません。9:00 の回で読み直します:", c.date);
    }
    if (c.mod >= SELECT_MINUTE) await ensureNextDayTargets(c);
  })();
}

function start() {
  if (!GITHUB_TOKEN) {
    log("BOOK_GITHUB_TOKEN が未設定のため、板の記録は起動しません");
    return;
  }
  cron.schedule("* * * * *", function () { tick(); }, { timezone: TZ });
  log("起動しました。平日 9:00〜11:30・12:30〜15:30(JST) に1分おき・" + CHUNK_SIZE + "件ずつ取得します。保存先:",
    GITHUB_REPO, "/ 項目数 full " + FULL_COLS.length + "・front " + FRONT_COLS.length);
  guarded("起動時の準備", startup);
}

module.exports = { start: start };
