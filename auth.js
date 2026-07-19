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

// base64 + RSA-OAEP(SHA256) で暗号化された仮想URLを秘密鍵で復号する
function decryptUrl(encryptedB64) {
  var buf = Buffer.from(encryptedB64, "base64");
  var decrypted = crypto.privateDecrypt(
    {
      key: config.privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    buf
  );
  return decrypted.toString("ascii").replace(/[\r\n]+$/, "");
}

async function login() {
  var params = Object.assign(nextHeader(), {
    sCLMID: "CLMAuthLoginRequest",
    sAuthId: config.authId,
  });
  var ans = await postToServer(config.urlAuth, params);
  checkAnswer(ans);

  state.urls = {
    sUrlRequest: decryptUrl(ans.sUrlRequest),
    sUrlMaster: decryptUrl(ans.sUrlMaster),
    sUrlPrice: decryptUrl(ans.sUrlPrice),
    sUrlEvent: decryptUrl(ans.sUrlEvent),
    sUrlEventWebSocket: decryptUrl(ans.sUrlEventWebSocket),
  };
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

module.exports = {
  ensureSession: ensureSession,
  reLogin: reLogin,
  postToServer: postToServer,
  checkAnswer: checkAnswer,
  nextHeader: nextHeader,
};
