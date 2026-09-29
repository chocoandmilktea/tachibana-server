// tachibana-server/webapi.js
// Vercel（stock.js等）からのオンデマンド問い合わせに応える簡易HTTPサーバー。
// 既にログイン済みのセッション（auth.js）を使い回すことで、Vercel側で
// 毎回ログインし直す必要をなくす。新しい依存パッケージは追加せず、
// Node標準のhttpモジュールとグローバルのURLのみ使用。
//
// 現時点では /topix（TOPIX前日比%）のみ対応。今後、PER/PBR等を
// 追加する場合もこのファイルにエンドポイントを増やしていく想定。

var http = require("http");
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

// ── TOPIX前日比%（1時間キャッシュ＋取得中Promiseの共有） ──────────────────
var topixCache = { change: null, ts: 0 };
var TOPIX_TTL = 60 * 60 * 1000;
// 取得中のPromiseを保持し、同時に来たリクエストは全て同じPromiseを待つ。
// キャッシュが空の状態で短時間に何本も来ると、立花証券APIへ同じ問い合わせが
// 重複して飛んでしまうため（実測: 13秒間に15回）、それを1回にまとめる。
var topixInflight = null;

async function fetchTopixChange() {
  var session = await auth.ensureSession();

  // 指数銘柄マスタ（v4r10のCLMStkGetIssueMstIndex）からTOPIXの銘柄コードを検索する。
  // 探し方は従来どおり「銘柄名にTOPIXを含む最初の行」
  var masterAns = await auth.request(session.sUrlMaster, {
    sCLMID: "CLMStkGetIssueMstIndex",
  });
  auth.checkAnswer(masterAns);
  if (!Array.isArray(masterAns.aCLMStkIssueMstIndex)) {
    throw new Error("指数銘柄マスタの応答に aCLMStkIssueMstIndex がありません");
  }
  var list = masterAns.aCLMStkIssueMstIndex;
  var topixItem = list.filter(function (item) {
    return String(item.sIssueName || "").indexOf("TOPIX") !== -1;
  })[0];
  if (!topixItem) {
    log("TOPIX銘柄が指数銘柄マスタに見つかりません（全", list.length, "件）");
    throw new Error("TOPIX銘柄が指数マスタに見つかりません");
  }
  log("TOPIX銘柄コード:", topixItem.sIssueCode);

  var histAns = await auth.request(session.sUrlPrice, {
    sCLMID: "CLMMfdsGetMarketPriceHistory",
    sIssueCode: topixItem.sIssueCode,
    sSizyouC: "00",
  });
  auth.checkAnswer(histAns);
  var hist = histAns.aCLMMfdsMarketPriceHistory || [];
  if (hist.length < 2) throw new Error("TOPIX日足データが不足しています");

  var last = hist[hist.length - 1];
  var prev = hist[hist.length - 2];
  var lastClose = parseFloat(last.pDPP);
  var prevClose = parseFloat(prev.pDPP);
  if (!prevClose) throw new Error("TOPIX前日終値が不正です");
  var change = (lastClose - prevClose) / prevClose * 100;

  topixCache = { change: change, ts: Date.now() };
  log("TOPIX取得成功。前日比:", change.toFixed(2) + "%");
  return change;
}

async function getTopixChange() {
  var now = Date.now();
  if (topixCache.change !== null && now - topixCache.ts < TOPIX_TTL) return topixCache.change;
  // 既に取得中なら、その結果に相乗りする
  if (topixInflight) return topixInflight;

  // 成功・失敗どちらでも必ずnullに戻す（失敗時に永久に同じ失敗Promiseを返さないため）。
  // エラーは従来どおりそのまま呼び出し元へ伝播する。
  topixInflight = fetchTopixChange().finally(function () {
    topixInflight = null;
  });
  return topixInflight;
}

// ── 銘柄詳細情報(PER/PBR/EPS/BPS/配当利回り・配当権利落日)。銘柄ごとに1時間キャッシュ ──
var issueDetailCache = {}; // code -> { data, ts }
var ISSUE_DETAIL_TTL = 60 * 60 * 1000;

async function getIssueDetail(code) {
  var now = Date.now();
  var cached = issueDetailCache[code];
  if (cached && now - cached.ts < ISSUE_DETAIL_TTL) return cached.data;

  var session = await auth.ensureSession();
  var ans = await auth.request(session.sUrlMaster, {
    sCLMID: "CLMMfdsGetIssueDetail",
    sTargetIssueCode: code,
  });
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

// ── 株式銘柄マスタ（v4r10のCLMStkGetIssueMstKabu）。24時間キャッシュ ──────────
// ランキング用（getRankingMaster）と銘柄名用（getNameMaster）の両方がこの結果を使う。
// 全銘柄分を1回で返すため応答が大きく、既定の10秒では足りない恐れがあるので30秒にする。
var kabuMasterCache = { ts: 0, list: null };
var KABU_MASTER_TTL = 24 * 60 * 60 * 1000;
var KABU_MASTER_TIMEOUT_MS = 30 * 1000;
// /ranking-data と /names が同時に来ても重い問い合わせを1回にまとめる（TOPIXと同じ方式）
var kabuMasterInflight = null;

async function fetchKabuMaster() {
  var session = await auth.ensureSession();
  var startedAt = Date.now();
  var ans = await auth.request(session.sUrlMaster, {
    sCLMID: "CLMStkGetIssueMstKabu",
  }, KABU_MASTER_TIMEOUT_MS);
  auth.checkAnswer(ans);
  // 空の一覧を「成功」として返すと、Vercel側がRedisに残している前回の正常なデータを
  // 空で上書きしてしまう。配列が無い・0件のときはエラーにし、キャッシュにも保存しない
  if (!Array.isArray(ans.aCLMStkIssueMstKabu)) {
    throw new Error("銘柄マスタの応答に aCLMStkIssueMstKabu がありません");
  }
  var list = ans.aCLMStkIssueMstKabu;
  if (list.length === 0) throw new Error("銘柄マスタの取得結果が0件です");

  kabuMasterCache = { ts: Date.now(), list: list };
  log("銘柄マスタ取得", list.length + "件", ((Date.now() - startedAt) / 1000).toFixed(1) + "秒");
  return list;
}

async function getKabuMaster() {
  if (kabuMasterCache.list && Date.now() - kabuMasterCache.ts < KABU_MASTER_TTL) return kabuMasterCache.list;
  if (kabuMasterInflight) return kabuMasterInflight;
  // 成功・失敗どちらでも必ずnullに戻す（失敗時に永久に同じ失敗Promiseを返さないため）
  kabuMasterInflight = fetchKabuMaster().finally(function () {
    kabuMasterInflight = null;
  });
  return kabuMasterInflight;
}

// ── 業種コード→業種名。v4r10の銘柄マスタは業種名を返さないため、ここで変換する ──
// アプリ側（daytrade-simulator）の業種絞り込みと1文字でも違うと一致しなくなるので、
// 表記（全角の「・」、証券の区切りの全角「、」）を変えないこと。
// 表に無いコード（9999:その他 など）は null 扱い
var GYOUSYU_NAMES = {
  "0050": "水産・農林業",
  "1050": "鉱業",
  "2050": "建設業",
  "3050": "食料品",
  "3100": "繊維製品",
  "3150": "パルプ・紙",
  "3200": "化学",
  "3250": "医薬品",
  "3300": "石油・石炭製品",
  "3350": "ゴム製品",
  "3400": "ガラス・土石製品",
  "3450": "鉄鋼",
  "3500": "非鉄金属",
  "3550": "金属製品",
  "3600": "機械",
  "3650": "電気機器",
  "3700": "輸送用機器",
  "3750": "精密機器",
  "3800": "その他製品",
  "4050": "電気・ガス業",
  "5050": "陸運業",
  "5100": "海運業",
  "5150": "空運業",
  "5200": "倉庫・運輸関連業",
  "5250": "情報・通信業",
  "6050": "卸売業",
  "6100": "小売業",
  "7050": "銀行業",
  "7100": "証券、商品先物取引業",
  "7150": "保険業",
  "7200": "その他金融業",
  "8050": "不動産業",
  "9050": "サービス業",
};

function gyousyuNameOf(code) {
  return Object.prototype.hasOwnProperty.call(GYOUSYU_NAMES, code) ? GYOUSYU_NAMES[code] : null;
}

// ── ランキング用データ(出来高・現在値・名前・業種)。全銘柄まとめて返す ────────
// 銘柄マスタは24時間キャッシュ（getKabuMaster側）、
// 出来高・現在値は3分キャッシュ（頻繁に呼ばれても毎回立花証券に問い合わせずに済むように）
// rankingMasterCache は「どの銘柄マスタから絞り込んだか」を src で覚え、マスタが更新された時だけ作り直す
var rankingMasterCache = { src: null, list: null };
var rankingDataCache = { ts: 0, rows: null };
var RANKING_DATA_TTL = 3 * 60 * 1000;

function chunk(arr, size) {
  var out = [];
  for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function getRankingMaster() {
  var all = await getKabuMaster();
  if (rankingMasterCache.src === all) return rankingMasterCache.list;

  // 業種コード9999(その他)はETF/REIT/投信等が多いため除外し、実株式のみに絞り込む
  var stocks = all.filter(function (i) { return i.sGyousyuCode !== "9999"; });

  rankingMasterCache = { src: all, list: stocks };
  log("銘柄マスタ更新:", stocks.length, "件（全", all.length, "件中）");
  return stocks;
}

// columns 省略時は従来どおり "pDPP,pPRP,pDV"（ランキング用）
async function fetchBatchPrice(session, codes, columns) {
  var ans = await auth.request(session.sUrlPrice, {
    sCLMID: "CLMMfdsGetMarketPrice",
    sTargetIssueCode: codes.join(","),
    sTargetColumn: columns || "pDPP,pPRP,pDV",
  });
  try {
    auth.checkAnswer(ans);
  } catch (e) {
    // 立花の生レスポンスを添付しておき、呼び出し元でそのまま返せるようにする
    e.answer = ans;
    throw e;
  }
  return ans.aCLMMfdsMarketPrice || [];
}

async function getRankingData() {
  var now = Date.now();
  if (rankingDataCache.rows && now - rankingDataCache.ts < RANKING_DATA_TTL) return rankingDataCache.rows;

  var master = await getRankingMaster();
  var nameMap = {}, sectorMap = {};
  master.forEach(function (i) {
    nameMap[i.sIssueCode] = i.sIssueName;
    sectorMap[i.sIssueCode] = gyousyuNameOf(i.sGyousyuCode);
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
  // 全バッチが失敗・空だった場合は、空の一覧を成功扱いで返さない（キャッシュにも保存しない）。
  // Vercel側がRedisに残している前回の正常なデータを空で上書きさせないため
  if (Object.keys(priceMap).length === 0) {
    throw new Error("株価の取得結果が全銘柄とも0件です（対象 " + codes.length + " 銘柄）");
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

// ── 銘柄名マスタ(コード→会社名)。ipo.js(/api/ipo)の代替用。24時間キャッシュ（getKabuMaster側） ──
// nameMasterCache は rankingMasterCache と同じく、元にした銘柄マスタを src で覚える
var nameMasterCache = { src: null, names: null };

async function getNameMaster() {
  var list = await getKabuMaster();
  if (nameMasterCache.src === list) return nameMasterCache.names;

  var names = {};
  list.forEach(function (i) {
    if (i.sIssueCode && i.sIssueName) names[i.sIssueCode] = i.sIssueName;
  });

  nameMasterCache = { src: list, names: names };
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
    // url.parse() は非推奨のためグローバルのURLを使う。
    // req.url はパス以降のみなので、ベースにダミーのオリジンを与えて解釈させる。
    var parsed = new URL(req.url, "http://localhost");

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
      var code = parsed.searchParams.get("code");
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

// fetchBatchPrice は現状このファイル内（getRankingData）からのみ使う。
// 常駐サーバー内の他モジュールが自分自身をHTTPで叩かずに済むよう export は残す
module.exports = { start: start, fetchBatchPrice: fetchBatchPrice };
