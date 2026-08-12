// tachibana-server/scanner.js
// 定時自動スキャンのスケジューラ（Phase 3）
//
// 指定時刻になったら Vercel の scan-run（api/sync.js?resource=scan-run）を
// 全銘柄ぶん繰り返し呼び出し、自動スキャンを完走させる。
// このファイルは「時計とループ制御」だけを担当し、株価取得もスコア計算も一切行わない
// （計算はすべてVercel側の api/_scan.js が行う）。
//
// 【なぜ1バッチ5件・直列なのか（実測済みの前提）】
// ・Vercel Hobbyの関数は10秒でタイムアウトする
// ・limit=5 で実測4.5秒。limit=8 はタイムアウトして失敗した
// ・scan-run は Redis の read-modify-write のため、絶対に並列実行してはいけない
// したがってバッチサイズは5固定、呼び出しは必ず直列（前の応答を待ってから次）。
//
// 【なぜバッチ間に1秒待つのか】
// Vercel側(api/_scan.js)のYahoo 429対策の待機(300ms)はバッチ内の銘柄間にしか
// 入らず、バッチの境界では抜けてしまうため、こちら側で1秒あける。

var cron = require("node-cron");
var config = require("./config");
var holidays = require("./holidays");

function log() {
  var args = Array.prototype.slice.call(arguments);
  console.log.apply(console, ["[scan]"].concat(args));
}

// ── 設定（すべて既定値あり。環境変数が未設定でもそのまま動く） ─────────────
function envStr(name, def) {
  var v = process.env[name];
  return (v == null || String(v).trim() === "") ? def : String(v).trim();
}

// Railwayのサーバー時刻はUTCのため、タイムゾーンは必ず明示する（省略すると9時間ずれる）
var TZ = "Asia/Tokyo";

var ENABLED = envStr("SCAN_ENABLED", "true").toLowerCase() !== "false";
var TIMES = envStr("SCAN_TIMES", "8:45,9:30,11:00,13:00,15:00");
var API_BASE = envStr("VERCEL_API_BASE", "https://daytrade-simulator.vercel.app").replace(/\/+$/, "");

// 5件を超えるとVercel側が10秒でタイムアウトして必ず失敗するため、上限で丸める
var MAX_BATCH_SIZE = 5;
var BATCH_SIZE = (function () {
  var n = parseInt(envStr("SCAN_BATCH_SIZE", "5"), 10);
  if (!isFinite(n) || n <= 0) return MAX_BATCH_SIZE;
  return n > MAX_BATCH_SIZE ? MAX_BATCH_SIZE : n;
})();

var SLOT_TIME_LIMIT_MS = 15 * 60 * 1000; // 1スロットの総実行時間の上限
var BATCH_INTERVAL_MS = 1000;            // バッチ間の待機
var RETRY_WAIT_MS = 3000;                // 失敗時に再試行するまでの待機
var REQUEST_TIMEOUT_MS = 20 * 1000;      // 1回のHTTP呼び出しの上限（Vercel側は10秒で切れる）
var MAX_BATCHES = 400;                   // 暴走防止（5件×400＝2000銘柄ぶん）

// api/_scan.js の SLOT_SESSIONS と同じ5つ。ここに無いslotを渡すとVercel側が
// 400（unknown slot）を返して何も処理しないため、必ずこの中のどれかに丸めて渡す。
var SLOTS = ["0830", "0930", "1100", "1300", "1500"];

// ── 時刻まわり ─────────────────────────────────────────────────────────
// 実行時刻を、その時刻が属する時間帯（直前のslot）に丸める。
// 例: 8:45→"0830" / 9:30→"0930" / 11:00→"1100"
function slotForTime(hour, minute) {
  var mins = hour * 60 + minute;
  var found = SLOTS[0];
  for (var i = 0; i < SLOTS.length; i++) {
    var s = SLOTS[i];
    var m = parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(2), 10);
    if (m <= mins) found = s;
  }
  return found;
}

// SCAN_TIMES（"8:45,9:30,..."）を解釈する。解釈できない要素は読み飛ばす。
function parseTimes(src) {
  var out = [];
  String(src).split(",").forEach(function (raw) {
    var text = raw.trim();
    if (!text) return;
    var m = /^(\d{1,2}):(\d{1,2})$/.exec(text);
    if (!m) {
      log("SCAN_TIMES の時刻を解釈できません（読み飛ばします）:", text);
      return;
    }
    var hour = parseInt(m[1], 10);
    var minute = parseInt(m[2], 10);
    if (hour > 23 || minute > 59) {
      log("SCAN_TIMES の時刻が範囲外です（読み飛ばします）:", text);
      return;
    }
    out.push({ text: text, hour: hour, minute: minute, slot: slotForTime(hour, minute) });
  });
  return out;
}

// JSTの当日（YYYY-MM-DD）。サーバー時刻はUTCなので、UTCのまま日付を取ると
// 日本時間の朝でも前日になってしまう。+9時間してから日付部分だけ取り出す。
function jstDateString() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function formatDuration(ms) {
  var sec = Math.round(ms / 1000);
  var min = Math.floor(sec / 60);
  return min > 0 ? (min + "分" + (sec % 60) + "秒") : (sec + "秒");
}

// ── Vercelへの呼び出し ───────────────────────────────────────────────────
function authHeaders() {
  var h = { "Content-Type": "application/json" };
  if (config.relaySecret) h["X-Relay-Secret"] = config.relaySecret;
  return h;
}

async function postScanBatch(date, slot, offset) {
  var res = await fetch(API_BASE + "/api/sync?resource=scan-run", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ date: date, slot: slot, offset: offset, limit: BATCH_SIZE }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  var body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  return { status: res.status, body: body || {} };
}

// 呼び出し結果をログ用の短い文字列にする
function describe(r) {
  var err = r.body && r.body.error;
  return "status=" + r.status + (err ? " " + err : "");
}

// ── 1スロット分の実行 ───────────────────────────────────────────────────
// 前のスロットがまだ走っている間は新しいスロットを開始しない（排他制御）。
// scan-run は Redis の read-modify-write なので、重なると結果が壊れる。
var running = false;
var runningSlot = null;

async function runScanSlot(slot) {
  var date = jstDateString();

  // 休場日（土日・祝日・年末年始）はバッチを1回も投げずに終わる。
  // 前日終値しか取れず統計を汚すうえ、外部APIの無駄打ちになるため。
  if (holidays.isMarketClosed(date)) {
    log(slot, "休場日のためスキップします:", date);
    return;
  }

  if (running) {
    log(slot, "前のスロット(" + runningSlot + ")が実行中のため、今回は開始しません");
    return;
  }
  running = true;
  runningSlot = slot;

  var startedAt = Date.now();
  log(slot + " start " + date);

  var offset = 0;
  var totalStocks = null;   // 銘柄リスト全体の件数（最初の成功バッチで判明する）
  var doneCount = 0;        // 保存できた銘柄数
  var failedStocks = 0;     // 個別に失敗した銘柄数
  var skippedBatches = 0;   // 再試行しても駄目で飛ばしたバッチ数
  var batchCount = 0;
  var abortReason = null;

  try {
    while (true) {
      if (Date.now() - startedAt > SLOT_TIME_LIMIT_MS) {
        abortReason = "総実行時間が15分を超えたため中断";
        break;
      }
      if (batchCount >= MAX_BATCHES) {
        abortReason = "バッチ数が上限(" + MAX_BATCHES + ")に達したため中断";
        break;
      }

      var r = null;
      try {
        r = await postScanBatch(date, slot, offset);
      } catch (e) {
        r = { status: 0, body: { error: e.message } };
      }

      // 銘柄リスト未登録(universe empty)・slot不正など、繰り返しても無駄なものは即中断
      if (r.status === 400) {
        abortReason = "Vercelが処理不能と応答: " + (r.body.error || "400");
        break;
      }
      if (r.status === 401) {
        abortReason = "認証エラー（X-Relay-Secret / TACHIBANA_RELAY_SECRET を確認）";
        break;
      }

      // 失敗したら3秒待って1回だけ再試行する
      if (r.status !== 200) {
        log(slot, "offset=" + offset, "失敗(" + describe(r) + ")。3秒後に1回だけ再試行します");
        await sleep(RETRY_WAIT_MS);
        try {
          r = await postScanBatch(date, slot, offset);
        } catch (e2) {
          r = { status: 0, body: { error: e2.message } };
        }
      }

      batchCount++;

      // 再試行しても駄目ならそのバッチは飛ばして次のoffsetへ進む（全体は止めない）
      if (r.status !== 200) {
        skippedBatches++;
        log(slot, "offset=" + offset, "を飛ばして次に進みます(" + describe(r) + ")");
        if (totalStocks == null) {
          // 1回も成功していない＝全体件数が分からず、どこまで進めばよいか判断できない
          abortReason = "最初のバッチが失敗し全体件数が不明なため中断";
          break;
        }
        offset += BATCH_SIZE;
        if (offset >= totalStocks) break;
        await sleep(BATCH_INTERVAL_MS);
        continue;
      }

      var body = r.body || {};
      doneCount += Number(body.done) || 0;
      failedStocks += Array.isArray(body.failed) ? body.failed.length : 0;
      if (body.total != null) totalStocks = Number(body.total);

      if (body.nextOffset == null) break; // 全件終了
      offset = Number(body.nextOffset);
      await sleep(BATCH_INTERVAL_MS);
    }
  } catch (e) {
    abortReason = "予期しないエラー: " + e.message;
  } finally {
    running = false;
    runningSlot = null;
  }

  var tail = doneCount + "件 " + formatDuration(Date.now() - startedAt) + " 失敗" + failedStocks + "件" +
    (skippedBatches ? " スキップ" + skippedBatches + "バッチ" : "");
  if (abortReason) log(slot + " abort " + abortReason + " / " + tail);
  else log(slot + " done " + tail);
}

// ── 起動 ───────────────────────────────────────────────────────────────
function start() {
  if (!ENABLED) {
    log("SCAN_ENABLED=false のため、自動スキャンは起動しません");
    return;
  }

  var times = parseTimes(TIMES);
  if (!times.length) {
    log("SCAN_TIMES に有効な時刻がないため、自動スキャンは起動しません:", TIMES);
    return;
  }

  times.forEach(function (t) {
    // 月〜金のみ実行（曜日 1-5）。土日は市場が閉まっているため登録しない。
    var expr = t.minute + " " + t.hour + " * * 1-5";
    if (!cron.validate(expr)) {
      log("cron式が不正なため登録しません:", expr);
      return;
    }
    cron.schedule(expr, function () {
      runScanSlot(t.slot).catch(function (e) { log("予期しないエラー:", e.message); });
    }, { timezone: TZ });
    log("登録:", t.text, "(" + TZ + " 月〜金) → slot", t.slot);
  });

  log("起動しました。宛先:", API_BASE, "/ バッチサイズ:", BATCH_SIZE, "件");
}

// runScanSlot は動作確認用に公開している（通常はcronからのみ呼ばれる）
module.exports = { start: start, runScanSlot: runScanSlot };
