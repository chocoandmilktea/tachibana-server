// 立花証券 e支店API v4r9 ログイン処理
// 参考: 立花証券公式サンプル e_api_sample_v4r9.py の CLMAuthLoginRequest 部分を
//       Node.js に移植したもの。仕様の詳細は公式マニュアルを参照してください。

var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var iconv = require("iconv-lite");
var config = require("./config");

var SESSION_FILE = path.join(__dirname, "session.json"); // 当日分のセッションを保存

var state = {
  pNo: 0,
  urls: null, // {sUrlRequest, sUrlMaster, sUrlPrice, sUrlEvent, sUrlEventWebSocket}
  loadedAt: 0, // 今のセッションを取得した時刻(epoch ms)。日次の再ログイン判定に使う
};

// Railway等のサーバーはUTC(またはサーバー所在地のTZ)で動くことが多いため、
// サーバーのタイムゾーン設定に依存せず、常にJST(UTC+9)を計算する
function nowJst() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function todayStr() {
  var d = nowJst();
  return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0");
}

// 日次の再ログインを行う時刻（JST）。
// 立花証券APIは毎日3:00〜8:30がシステムメンテナンスで、メンテ中に取得した
// セッションはメンテ明けに無効化されてしまう（以後 p_errno=2 が返り続ける）。
// そのためメンテ明けの8:35に再ログインする。
// ※8:45のpremarket収集・8:50の自動スキャンより前に完了する必要がある
var RELOGIN_HOUR_JST = 8;
var RELOGIN_MINUTE_JST = 35;

// 本日の再ログイン時刻(8:35 JST)を epoch ms で返す
function todayReLoginTimeMs() {
  var d = nowJst();
  var jstMidnightUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  // JSTの壁時計を実時刻(UTC基準のepoch)に戻すため9時間引く
  return jstMidnightUtc + (RELOGIN_HOUR_JST * 60 + RELOGIN_MINUTE_JST) * 60 * 1000 - 9 * 60 * 60 * 1000;
}

function loadSession() {
  try {
    var raw = fs.readFileSync(SESSION_FILE, "utf8");
    var saved = JSON.parse(raw);
    if (saved.date === todayStr() && saved.urls && saved.urls.sUrlRequest) {
      state.pNo = saved.pNo || 0;
      state.urls = saved.urls;
      state.loadedAt = saved.loadedAt || 0;
      return true;
    }
  } catch (e) {
    // ファイルが無い/壊れている場合は素通りして再ログインする
  }
  return false;
}

function saveSession() {
  fs.writeFileSync(
    SESSION_FILE,
    JSON.stringify({ date: todayStr(), pNo: state.pNo, urls: state.urls, loadedAt: state.loadedAt }, null, 2)
  );
}

function nextHeader() {
  state.pNo += 1;
  var d = nowJst();
  var pad = function (n) { return String(n).padStart(2, "0"); };
  var pSdDate =
    d.getUTCFullYear() + "." + pad(d.getUTCMonth() + 1) + "." + pad(d.getUTCDate()) + "-" +
    pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds()) + ".000";
  return { p_no: String(state.pNo), p_sd_date: pSdDate, sJsonOfmt: "5" };
}

// ── p_no（通番）の直列化 ────────────────────────────────────────────────
// 立花証券APIは「リクエストの p_no がサーバー到着順に増えていること」を要求する。
// 採番後に Promise.all 等で並列送信すると採番順と到着順が入れ替わり、
// 後から採番したリクエストが先に着くと p_errno=6 で弾かれる。
// そのため「採番 → 送信開始」までを1本のPromiseチェーンで直列化する。
// 応答待ちは直列化しない（遅くなるため並列のまま）。
var sendChain = Promise.resolve();
// 送信の間隔。ネットワークの揺らぎ（送信〜到着のばらつき）より大きくないと追い越しが起きる
var SEND_GAP_MS = parseInt(process.env.TACHIBANA_SEND_GAP_MS || "15", 10);
// リトライ時の間隔。後続の採番を長めに止めて「追い越されない」状態を作ってから再送する
var RETRY_GAP_MS = parseInt(process.env.TACHIBANA_RETRY_GAP_MS || "150", 10);
var PNO_RETRY_MAX = 2; // p_errno=6 が返ったときに採番し直して再送する最大回数
// 立花証券へのPOST1回あたりのタイムアウト既定値。
// 全銘柄マスタ等の重い応答でも実測4秒程度なので10秒あれば足りる。
var POST_TIMEOUT_MS = 10000;

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// 採番と送信開始だけを直列化してPOSTする（1回のみ。リトライはrequest側で行う）
function postSerialized(url, paramsObj, gapMs, timeoutMs) {
  // gate は「採番 → 送信開始 → 次の採番までの間隔」まで待つPromise
  var gate = sendChain.then(function () {
    var params = Object.assign(nextHeader(), paramsObj);
    var resPromise = postToServer(url, params, timeoutMs); // ここで送信が始まる
    resPromise.catch(function () {}); // 応答は下段で待つので、未処理拒否の警告だけ防ぐ
    return sleep(gapMs).then(function () {
      // 応答Promiseはオブジェクトに包む（thenで自動的に待たれてしまうのを防ぐため）
      return { res: resPromise };
    });
  });
  // 次のリクエストは「送信開始まで」を待てばよい。応答は待たせない
  sendChain = gate.then(function () {}, function () {});
  return gate.then(function (holder) { return holder.res; });
}

// エラー応答から立花サーバー側が最後に受け付けた p_no を読み取る
// 例: 引数（p_no:[1449] <= 前要求.p_no:[1450]）エラー。
function extractServerPno(ans) {
  var text = String((ans && ans.p_err) || "");
  var re = /p_no:\[(\d+)\]/g;
  var max = 0;
  var m;
  while ((m = re.exec(text)) !== null) {
    var n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max || null;
}

// p_errno=6（通番エラー）が返った場合は採番し直して最大PNO_RETRY_MAX回リトライする。
async function requestWithPnoRetry(url, paramsObj, timeoutMs) {
  var ans = null;
  for (var attempt = 0; attempt <= PNO_RETRY_MAX; attempt++) {
    // 2回目以降は間隔を広げて送る（後続の採番を止めている間に確実に到着させるため）
    ans = await postSerialized(url, paramsObj, attempt === 0 ? SEND_GAP_MS : RETRY_GAP_MS, timeoutMs);
    if (String(ans && ans.p_errno) !== "6") return ans;
    // サーバーが受け付け済みの通番より確実に大きい値から採番し直す
    var serverPno = extractServerPno(ans);
    if (serverPno && serverPno > state.pNo) state.pNo = serverPno;
  }
  // リトライしても通番エラーのまま。呼び出し側のcheckAnswerでエラーとして扱われる
  return ans;
}

// ── セッション切断(p_errno=2)からの自動復旧 ─────────────────────────────
// メンテナンス(3:00〜8:30)明けなどでセッションが無効になると、以後の全リクエストが
// p_errno=2 で失敗し続け、サーバーを再起動するまで復旧しない。
// そのため p_errno=2 を検知したらその場で再ログインし、同じリクエストを1回だけ再送する。
var reLoginPromise = null; // 進行中の再ログインを共有し、同時に何本もログインを叩かないようにする

function reLoginShared() {
  if (!reLoginPromise) {
    reLoginPromise = reLogin().finally(function () { reLoginPromise = null; });
  }
  return reLoginPromise;
}

// 再ログインすると仮想URLは新しいものに変わるため、
// 旧セッションのどのURLだったか（sUrlMaster等）を覚えておいて読み替える
function urlKeyOf(target) {
  if (!state.urls) return null;
  var keys = Object.keys(state.urls);
  for (var i = 0; i < keys.length; i++) {
    if (state.urls[keys[i]] === target) return keys[i];
  }
  return null;
}

// 立花証券APIへのリクエスト共通入口。p_no は内部で採番するので呼び出し側は業務パラメータのみ渡す。
// 通番エラー(p_errno=6)のリトライに加え、セッション切断(p_errno=2)なら再ログインして1回だけ再送する。
// timeoutMs はPOST1回あたりのタイムアウト（省略時10秒）。再送にも同じ値が効く。
async function request(url, paramsObj, timeoutMs) {
  var sentAt = Date.now();
  var ans = await requestWithPnoRetry(url, paramsObj, timeoutMs);
  // ログイン要求自体はここで再ログインさせない（無限ループになるため）
  if (String(ans && ans.p_errno) !== "2" || paramsObj.sCLMID === "CLMAuthLoginRequest") return ans;

  console.log("[auth] セッション切断を検知。再ログインします。");
  var key = urlKeyOf(url); // 再ログイン前に控えておく（reLoginでstate.urlsがクリアされるため）
  try {
    // 送信後に別のリクエストが再ログイン済みなら、そのセッションで再送するだけでよい
    var urls = state.loadedAt > sentAt ? state.urls : await reLoginShared();
    // リトライは1回だけ。ここでは request ではなく requestWithPnoRetry を呼ぶので再帰しない
    var retry = await requestWithPnoRetry((key && urls && urls[key]) || url, paramsObj, timeoutMs);
    if (String(retry && retry.p_errno) !== "0") {
      var err = new Error("p_errno=" + (retry && retry.p_errno) + " p_err=" + (retry && retry.p_err));
      err.answer = retry;
      throw err;
    }
    console.log("[auth] 再ログイン後のリトライ成功");
    return retry;
  } catch (e) {
    console.log("[auth] 再ログイン後のリトライも失敗: " + e.message);
    throw e;
  }
}

// 立花証券サーバーへPOST（応答はShiftJISで返ってくる）
// 素のfetchはタイムアウトを持たないため、立花側が無応答になると呼び出し側が
// 無期限にブロックする（寄り前の気配収集が1ティックで止まる原因になる）。
// 必ず AbortSignal.timeout() を付け、時間切れは例外にして呼び出し側のエラー処理に載せる。
// timeoutMs を渡せば既定値(10秒)を上書きできる（応答が重い用途向けの逃げ道）。
async function postToServer(url, paramsObj, timeoutMs) {
  var timeout = timeoutMs != null ? timeoutMs : POST_TIMEOUT_MS;
  try {
    var res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(paramsObj),
      signal: AbortSignal.timeout(timeout),
    });
    // 本文の読み込み中に時間切れになることもあるため、ここまでtryに含める
    var buf = Buffer.from(await res.arrayBuffer());
    var text = iconv.decode(buf, "Shift_JIS");
    return JSON.parse(text);
  } catch (e) {
    // タイムアウトは TimeoutError（実装によっては AbortError）で飛んでくる
    if (e && (e.name === "TimeoutError" || e.name === "AbortError")) {
      console.warn("[tachibana] postToServer タイムアウト（" + timeout + "ms）");
      var err = new Error("立花証券APIへのPOSTがタイムアウトしました（" + timeout + "ms）");
      err.name = "TimeoutError";
      throw err;
    }
    throw e;
  }
}

function checkAnswer(ans) {
  var pErrno = ans.p_errno != null ? String(ans.p_errno) : "unknown";
  var sResultCode = ans.sResultCode != null ? String(ans.sResultCode) : "0";
  if (pErrno !== "0") {
    throw new Error("立花証券APIリクエストエラー p_errno=" + pErrno + " p_err=" + ans.p_err);
  }
  if (sResultCode !== "0") {
    throw new Error("立花証券APIアプリケーションエラー sResultCode=" + sResultCode + " " + (ans.sResultText || ""));
  }
}

// TACHIBANA_PRIVATE_KEY は「PEMそのまま」でも「base64エンコード済みの1行」でも
// どちらでも受け付ける（iPad等で複数行のクォート付き値を貼るのが難しいため）
function resolvePrivateKeyPem() {
  var raw = config.privateKeyPem.trim();
  if (raw.indexOf("-----BEGIN") === 0) return raw;
  return Buffer.from(raw, "base64").toString("utf8");
}

// base64 + RSA-OAEP(SHA256) で暗号化された仮想URLを秘密鍵で復号する
function decryptUrl(encryptedB64) {
  var buf = Buffer.from(encryptedB64, "base64");
  var decrypted = crypto.privateDecrypt(
    {
      key: resolvePrivateKeyPem(),
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    buf
  );
  return decrypted.toString("ascii").replace(/[\r\n]+$/, "");
}

async function login() {
  var ans = await request(config.urlAuth, {
    sCLMID: "CLMAuthLoginRequest",
    sAuthId: config.authId,
  });
  checkAnswer(ans);

  state.urls = {
    sUrlRequest: decryptUrl(ans.sUrlRequest),
    sUrlMaster: decryptUrl(ans.sUrlMaster),
    sUrlPrice: decryptUrl(ans.sUrlPrice),
    sUrlEvent: decryptUrl(ans.sUrlEvent),
    sUrlEventWebSocket: decryptUrl(ans.sUrlEventWebSocket),
  };
  state.loadedAt = Date.now(); // 今ログインした時刻を記録（日次の再ログイン判定に使う）
  saveSession();
  console.log("[auth] ログイン成功。仮想URLを取得しました。");
}

// 有効なセッション（仮想URL群）を返す。無ければログインする
async function ensureSession() {
  if (!state.urls) {
    if (!loadSession()) {
      await login();
    }
  }
  return state.urls;
}

// セッション切れが疑われる場合に呼ぶ（再ログインを強制）
async function reLogin() {
  state.urls = null;
  await login();
  return state.urls;
}

// 本日の再ログイン時刻(8:35 JST)を過ぎていて、まだその時刻以降のセッションを
// 取得していなければ再ログインする。
// 「日付」ではなく「時刻」で判定するのは、メンテ中(3:00〜8:30)に起動して取得した
// セッションも 8:35 に取り直す必要があるため。
// 再ログインした場合はtrueを返す（呼び出し側でWebSocket接続を張り直す必要がある）
async function refreshIfNeeded() {
  var reLoginTime = todayReLoginTimeMs();
  if (Date.now() < reLoginTime) return false; // まだ本日の再ログイン時刻より前
  if (state.loadedAt >= reLoginTime) return false; // 本日の再ログイン時刻以降に取得済み
  await reLogin();
  return true;
}

module.exports = {
  ensureSession: ensureSession,
  reLogin: reLogin,
  refreshIfNeeded: refreshIfNeeded,
  request: request, // 立花証券APIを叩くときはこれを使う（p_noの採番と直列化・リトライ込み）
  postToServer: postToServer,
  checkAnswer: checkAnswer,
  nextHeader: nextHeader,
};
