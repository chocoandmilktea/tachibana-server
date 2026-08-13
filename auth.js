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
  loadedDate: null,
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

// 立花証券APIサーバーの閉局時刻（毎日03:30）を過ぎているかどうか
function isPastDailyClosing() {
  var d = nowJst();
  return d.getUTCHours() > 3 || (d.getUTCHours() === 3 && d.getUTCMinutes() >= 30);
}

function loadSession() {
  try {
    var raw = fs.readFileSync(SESSION_FILE, "utf8");
    var saved = JSON.parse(raw);
    if (saved.date === todayStr() && saved.urls && saved.urls.sUrlRequest) {
      state.pNo = saved.pNo || 0;
      state.urls = saved.urls;
      state.loadedDate = saved.date;
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
    JSON.stringify({ date: todayStr(), pNo: state.pNo, urls: state.urls }, null, 2)
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

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// 採番と送信開始だけを直列化してPOSTする（1回のみ。リトライはrequest側で行う）
function postSerialized(url, paramsObj, gapMs) {
  // gate は「採番 → 送信開始 → 次の採番までの間隔」まで待つPromise
  var gate = sendChain.then(function () {
    var params = Object.assign(nextHeader(), paramsObj);
    var resPromise = postToServer(url, params); // ここで送信が始まる
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

// 立花証券APIへのリクエスト共通入口。p_no は内部で採番するので呼び出し側は業務パラメータのみ渡す。
// p_errno=6（通番エラー）が返った場合は採番し直して最大PNO_RETRY_MAX回リトライする。
async function request(url, paramsObj) {
  var ans = null;
  for (var attempt = 0; attempt <= PNO_RETRY_MAX; attempt++) {
    // 2回目以降は間隔を広げて送る（後続の採番を止めている間に確実に到着させるため）
    ans = await postSerialized(url, paramsObj, attempt === 0 ? SEND_GAP_MS : RETRY_GAP_MS);
    if (String(ans && ans.p_errno) !== "6") return ans;
    // サーバーが受け付け済みの通番より確実に大きい値から採番し直す
    var serverPno = extractServerPno(ans);
    if (serverPno && serverPno > state.pNo) state.pNo = serverPno;
  }
  // リトライしても通番エラーのまま。呼び出し側のcheckAnswerでエラーとして扱われる
  return ans;
}

// 立花証券サーバーへPOST（応答はShiftJISで返ってくる）
async function postToServer(url, paramsObj) {
  var res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(paramsObj),
  });
  var buf = Buffer.from(await res.arrayBuffer());
  var text = iconv.decode(buf, "Shift_JIS");
  return JSON.parse(text);
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
  state.loadedDate = todayStr(); // 今ログインした日付を記録（日次の再ログイン判定に使う）
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

// 閉局時刻(03:30)を過ぎていて、まだ本日分の再ログインをしていなければ再ログインする。
// 再ログインした場合はtrueを返す（呼び出し側でWebSocket接続を張り直す必要がある）
async function refreshIfNeeded() {
  if (!isPastDailyClosing()) return false;
  if (state.loadedDate === todayStr()) return false; // 今日すでにログイン済み
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
