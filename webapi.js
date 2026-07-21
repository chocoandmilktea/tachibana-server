// tachibana-server/webapi.js
// Vercel（stock.js等）からのオンデマンド問い合わせに応える簡易HTTPサーバー。
// 既にログイン済みのセッション（auth.js）を使い回すことで、Vercel側で
// 毎回ログインし直す必要をなくす。新しい依存パッケージは追加せず、
// Node標準のhttp/urlモジュールのみ使用。
//
// 現時点では /topix（TOPIX前日比%）のみ対応。今後、PER/PBR等を
// 追加する場合もこのファイルにエンドポイントを増やしていく想定。

var http = require("http");
var url = require("url");
var auth = require("./auth");
var config = require("./config");

function log() {
  var args = Array.prototype.slice.call(arguments);
  console.log.apply(console, ["[webapi]"].concat(args));
}

function checkSecret(req) {
  if (!config.relaySecret) return true; // 合言葉未設定なら常に許可（README方針と同じ）
  return req.headers["x-relay-secret"] === config.relaySecret;
}

// ── TOPIX前日比%（1時間キャッシュ） ──────────────────────────────────────
var topixCache = { change: null, ts: 0 };
var TOPIX_TTL = 60 * 60 * 1000;

async function getTopixChange() {
  var now = Date.now();
  if (topixCache.change !== null && now - topixCache.ts < TOPIX_TTL) return topixCache.change;

  var session = await auth.ensureSession();

  // 指数マスタからTOPIXの銘柄コードを検索（verify-topix.jsで確認済みの方式）
  var masterParams = Object.assign(auth.nextHeader(), {
    sCLMID: "CLMMfdsGetMasterData",
    sTargetCLMID: "CLMIssueMstIndex",
  });
  var masterAns = await auth.postToServer(session.sUrlMaster, masterParams);
  auth.checkAnswer(masterAns);
  var list = masterAns.CLMIssueMstIndex || [];
  var topixItem = list.filter(function (item) {
    return String(item.sIssueName || "").indexOf("TOPIX") !== -1;
  })[0];
  if (!topixItem) throw new Error("TOPIX銘柄が指数マスタに見つかりません");

  var histParams = Object.assign(auth.nextHeader(), {
    sCLMID: "CLMMfdsGetMarketPriceHistory",
    sIssueCode: topixItem.sIssueCode,
    sSizyouC: "00",
  });
  var histAns = await auth.postToServer(session.sUrlPrice, histParams);
  auth.checkAnswer(histAns);
  var hist = histAns.aCLMMfdsMarketPriceHistory || [];
  if (hist.length < 2) throw new Error("TOPIX日足データが不足しています");

  var last = hist[hist.length - 1];
  var prev = hist[hist.length - 2];
  var lastClose = parseFloat(last.pDPP);
  var prevClose = parseFloat(prev.pDPP);
  if (!prevClose) throw new Error("TOPIX前日終値が不正です");
  var change = (lastClose - prevClose) / prevClose * 100;

  topixCache = { change: change, ts: now };
  log("TOPIX取得成功。前日比:", change.toFixed(2) + "%");
  return change;
}

function sendJson(res, statusCode, obj) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function start() {
  var port = process.env.PORT || 8080;

  var server = http.createServer(function (req, res) {
    var parsed = url.parse(req.url, true);

    if (parsed.pathname === "/topix" && req.method === "GET") {
      if (!checkSecret(req)) return sendJson(res, 401, { error: "unauthorized" });
      getTopixChange()
        .then(function (change) { sendJson(res, 200, { change: change }); })
        .catch(function (e) {
          log("TOPIX取得エラー:", e.message);
          sendJson(res, 500, { error: e.message });
        });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });

  server.listen(port, function () {
    log("HTTPサーバー起動。ポート:", port);
  });
}

module.exports = { start: start };
