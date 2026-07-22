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

// ── 銘柄詳細情報(PER/PBR/EPS/BPS/配当利回り・配当権利落日)。銘柄ごとに1時間キャッシュ ──
var issueDetailCache = {}; // code -> { data, ts }
var ISSUE_DETAIL_TTL = 60 * 60 * 1000;

async function getIssueDetail(code) {
  var now = Date.now();
  var cached = issueDetailCache[code];
  if (cached && now - cached.ts < ISSUE_DETAIL_TTL) return cached.data;

  var session = await auth.ensureSession();
  var params = Object.assign(auth.nextHeader(), {
    sCLMID: "CLMMfdsGetIssueDetail",
    sTargetIssueCode: code,
  });
  var ans = await auth.postToServer(session.sUrlMaster, params);
  auth.checkAnswer(ans);
  var list = ans.aCLMMfdsIssueDetail || [];
  var item = list[0];
  if (!item) throw new Error("銘柄詳細が見つかりません: " + code);

  var data = {
    per: item.pRPER ? parseFloat(item.pRPER) : null,
    pbr: item.pSPBR ? parseFloat(item.pSPBR) : null,
    eps: item.pEPSF ? parseFloat(item.pEPSF) : null,
    bps: item.pBPSB ? parseFloat(item.pBPSB) : null,
    dividendYield: item.pSYIE ? parseFloat(item.pSYIE) : null,
    // pCLOEは「YYYY/MM/DD」形式で返るため、アプリ側で使いやすいよう「YYYY-MM-DD」に変換
    exRightsDate: item.pCLOE ? item.pCLOE.replace(/\//g, "-") : null,
  };

  issueDetailCache[code] = { data: data, ts: now };
  log("銘柄詳細取得成功:", code, JSON.stringify(data));
  return data;
}

// ── ランキング用データ(出来高・現在値・名前・業種)。全銘柄まとめて返す ────────
// 銘柄マスタは24時間キャッシュ（滅多に変わらないため）、
// 出来高・現在値は3分キャッシュ（頻繁に呼ばれても毎回立花証券に問い合わせずに済むように）
var rankingMasterCache = { ts: 0, list: null };
var RANKING_MASTER_TTL = 24 * 60 * 60 * 1000;
var rankingDataCache = { ts: 0, rows: null };
var RANKING_DATA_TTL = 3 * 60 * 1000;

function chunk(arr, size) {
  var out = [];
  for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function getRankingMaster() {
  var now = Date.now();
  if (rankingMasterCache.list && now - rankingMasterCache.ts < RANKING_MASTER_TTL) return rankingMasterCache.list;

  var session = await auth.ensureSession();
  var params = Object.assign(auth.nextHeader(), {
    sCLMID: "CLMMfdsGetMasterData",
    sTargetCLMID: "CLMIssueMstKabu",
    sTargetColumn: "sIssueCode,sIssueName,sGyousyuCode,sGyousyuName",
  });
  var ans = await auth.postToServer(session.sUrlMaster, params);
  auth.checkAnswer(ans);
  var all = ans.CLMIssueMstKabu || [];
  // 業種コード9999(その他)はETF/REIT/投信等が多いため除外し、実株式のみに絞り込む
  var stocks = all.filter(function (i) { return i.sGyousyuCode !== "9999"; });

  rankingMasterCache = { ts: now, list: stocks };
  log("銘柄マスタ更新:", stocks.length, "件（全", all.length, "件中）");
  return stocks;
}

async function fetchBatchPrice(session, codes) {
  var params = Object.assign(auth.nextHeader(), {
    sCLMID: "CLMMfdsGetMarketPrice",
    sTargetIssueCode: codes.join(","),
    sTargetColumn: "pDPP,pPRP,pDV",
  });
  var ans = await auth.postToServer(session.sUrlPrice, params);
  auth.checkAnswer(ans);
  return ans.aCLMMfdsMarketPrice || [];
}

async function getRankingData() {
  var now = Date.now();
  if (rankingDataCache.rows && now - rankingDataCache.ts < RANKING_DATA_TTL) return rankingDataCache.rows;

  var master = await getRankingMaster();
  var nameMap = {}, sectorMap = {};
  master.forEach(function (i) {
    nameMap[i.sIssueCode] = i.sIssueName;
    sectorMap[i.sIssueCode] = i.sGyousyuName;
  });

  var session = await auth.ensureSession();
  var codes = master.map(function (i) { return i.sIssueCode; });
  var batches = chunk(codes, 120);

  var priceMap = {};
  var concurrency = 5; // 検証済み：この並列数で全銘柄の取得が約4秒で完了する
  for (var j = 0; j < batches.length; j += concurrency) {
    var group = batches.slice(j, j + concurrency);
    var results = await Promise.allSettled(group.map(function (b) { return fetchBatchPrice(session, b); }));
    results.forEach(function (r) {
      if (r.status === "fulfilled") {
        r.value.forEach(function (p) { priceMap[p.sIssueCode] = p; });
      } else {
        log("バッチ取得エラー:", r.reason.message);
      }
    });
  }

  var rows = codes.map(function (code) {
    var p = priceMap[code];
    if (!p) return null;
    var price = parseFloat(p.pDPP) || parseFloat(p.pPRP) || 0;
    var prevClose = parseFloat(p.pPRP) || 0;
    var volume = parseFloat(p.pDV) || 0;
    // 値段が全く取れない銘柄（上場前・廃止等）のみ除外。
    // 出来高0（寄付き前などまだ売買が無い状態）は除外しない
    if (!price) return null;
    return {
      code: code,
      name: nameMap[code] || code,
      sector: sectorMap[code] || null,
      price: price,
      prevClose: prevClose,
      volume: volume,
    };
  }).filter(Boolean);

  rankingDataCache = { ts: now, rows: rows };
  log("ランキング用データ更新:", rows.length, "件");
  return rows;
}

// ── 銘柄名マスタ(コード→会社名)。ipo.js(/api/ipo)の代替用。24時間キャッシュ ──
var nameMasterCache = { ts: 0, names: null };
var NAME_MASTER_TTL = 24 * 60 * 60 * 1000;

async function getNameMaster() {
  var now = Date.now();
  if (nameMasterCache.names && now - nameMasterCache.ts < NAME_MASTER_TTL) return nameMasterCache.names;

  var session = await auth.ensureSession();
  var params = Object.assign(auth.nextHeader(), {
    sCLMID: "CLMMfdsGetMasterData",
    sTargetCLMID: "CLMIssueMstKabu",
    sTargetColumn: "sIssueCode,sIssueName",
  });
  var ans = await auth.postToServer(session.sUrlMaster, params);
  auth.checkAnswer(ans);
  var list = ans.CLMIssueMstKabu || [];

  var names = {};
  list.forEach(function (i) {
    if (i.sIssueCode && i.sIssueName) names[i.sIssueCode] = i.sIssueName;
  });

  nameMasterCache = { ts: now, names: names };
  log("銘柄名マスタ更新:", Object.keys(names).length, "件");
  return names;
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

    if (parsed.pathname === "/issue-detail" && req.method === "GET") {
      if (!checkSecret(req)) return sendJson(res, 401, { error: "unauthorized" });
      var code = parsed.query.code;
      if (!code) return sendJson(res, 400, { error: "code required" });
      getIssueDetail(code)
        .then(function (data) { sendJson(res, 200, data); })
        .catch(function (e) {
          log("銘柄詳細取得エラー:", e.message);
          sendJson(res, 500, { error: e.message });
        });
      return;
    }

    if (parsed.pathname === "/ranking-data" && req.method === "GET") {
      if (!checkSecret(req)) return sendJson(res, 401, { error: "unauthorized" });
      getRankingData()
        .then(function (rows) { sendJson(res, 200, { rows: rows }); })
        .catch(function (e) {
          log("ランキングデータ取得エラー:", e.message);
          sendJson(res, 500, { error: e.message });
        });
      return;
    }

    if (parsed.pathname === "/names" && req.method === "GET") {
      if (!checkSecret(req)) return sendJson(res, 401, { error: "unauthorized" });
      getNameMaster()
        .then(function (names) { sendJson(res, 200, { names: names }); })
        .catch(function (e) {
          log("銘柄名マスタ取得エラー:", e.message);
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
