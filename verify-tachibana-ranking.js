// ranking.js/sector.js移行のための検証スクリプト（iPad/Railway向け）。
// 既存の auth.js（ログイン・セッション管理）をそのまま再利用します。
//
// 確認する内容:
//   ①銘柄マスタから全銘柄を取得し、業種コード・売買単位(sBaibaiTani)から
//     ETF/REIT等を判別できそうかヒントを集める
//   ②「業種コード9999(その他)以外」を実株式とみなして絞り込んだ件数を確認
//   ③絞り込んだ銘柄の出来高・現在値を120件ずつバッチ取得し、
//     全銘柄分にかかる合計時間を計測する（逐次実行 / 5並列実行の両方で比較）
//
// 使い方: railway.json の startCommand を一時的に
//   "node verify-tachibana-ranking.js" に変更してデプロイし、Deployments のログを見てください。
// 確認が終わったら、必ず startCommand を "node index.js" に戻してください
// （戻さないとリアルタイム中継(watcher)・TOPIX/銘柄詳細の窓口(webapi)が止まったままになります）。

var auth = require("./auth");

function chunk(arr, size) {
  var out = [];
  for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchBatchPrice(session, codes) {
  var params = Object.assign(auth.nextHeader(), {
    sCLMID: "CLMMfdsGetMarketPrice",
    sTargetIssueCode: codes.join(","),
    sTargetColumn: "pDPP,pDV",
  });
  var ans = await auth.postToServer(session.sUrlPrice, params);
  auth.checkAnswer(ans);
  return ans.aCLMMfdsMarketPrice || [];
}

async function main() {
  var session = await auth.ensureSession();

  // ① 銘柄マスタ一括取得（ETF判別のヒント用にsBaibaiTani=売買単位も追加で見る）
  console.log("========== ① 銘柄マスタ一括取得 ==========");
  var masterParams = Object.assign(auth.nextHeader(), {
    sCLMID: "CLMMfdsGetMasterData",
    sTargetCLMID: "CLMIssueMstKabu",
    sTargetColumn: "sIssueCode,sIssueName,sGyousyuCode,sGyousyuName,sBaibaiTani",
  });
  var masterAns = await auth.postToServer(session.sUrlMaster, masterParams);
  auth.checkAnswer(masterAns);
  var all = masterAns.CLMIssueMstKabu || [];
  console.log("全件数:", all.length);

  var sector9999 = all.filter(function (i) { return i.sGyousyuCode === "9999"; });
  console.log("業種コード9999(その他)の件数:", sector9999.length, "（ETF/REIT等が混ざっていそうな候補）");
  console.log("そのsBaibaiTani(売買単位)サンプル10件:");
  sector9999.slice(0, 10).forEach(function (i) {
    console.log(" ", i.sIssueCode, i.sIssueName, "売買単位:", i.sBaibaiTani);
  });

  var normalSector = all.filter(function (i) { return i.sGyousyuCode !== "9999"; });
  console.log("業種コード9999以外(通常株式と思われる)の件数:", normalSector.length);
  console.log("そのsBaibaiTaniサンプル5件（比較用）:");
  normalSector.slice(0, 5).forEach(function (i) {
    console.log(" ", i.sIssueCode, i.sIssueName, "売買単位:", i.sBaibaiTani);
  });

  // ② 実験的に「業種コード9999以外」を実株式とみなして絞り込み
  var codes = normalSector.map(function (i) { return i.sIssueCode; });
  console.log("");
  console.log("========== ② 絞り込み後の対象銘柄数: " + codes.length + " ==========");

  // ③ 出来高・現在値の一括取得にかかる時間を計測（逐次 vs 5並列）
  var batches = chunk(codes, 120);
  console.log("");
  console.log("========== ③ バッチ取得の所要時間計測（バッチ数: " + batches.length + "） ==========");

  // -- 逐次実行 --
  var seqStart = Date.now();
  var seqSuccess = 0, seqFail = 0;
  for (var i = 0; i < batches.length; i++) {
    try {
      var rows = await fetchBatchPrice(session, batches[i]);
      seqSuccess += rows.length;
    } catch (e) {
      seqFail++;
      console.log("逐次実行 バッチ" + i + " 失敗:", e.message);
    }
  }
  var seqMs = Date.now() - seqStart;
  console.log("逐次実行: 合計", seqMs, "ms（約", (seqMs / 1000).toFixed(1), "秒） 取得成功件数:", seqSuccess, "失敗バッチ数:", seqFail);

  // -- 5並列実行 --
  console.log("");
  var parStart = Date.now();
  var parSuccess = 0, parFail = 0;
  var concurrency = 5;
  for (var j = 0; j < batches.length; j += concurrency) {
    var group = batches.slice(j, j + concurrency);
    var results = await Promise.allSettled(group.map(function (b) { return fetchBatchPrice(session, b); }));
    results.forEach(function (r) {
      if (r.status === "fulfilled") parSuccess += r.value.length;
      else { parFail++; console.log("並列実行 失敗:", r.reason.message); }
    });
  }
  var parMs = Date.now() - parStart;
  console.log("5並列実行: 合計", parMs, "ms（約", (parMs / 1000).toFixed(1), "秒） 取得成功件数:", parSuccess, "失敗バッチ数:", parFail);

  console.log("");
  console.log("========== 確認終了 ==========");
  console.log("結果を確認できたら、railway.json の startCommand を \"node index.js\" に戻してください。");
}

main().catch(function (e) {
  console.error("[エラー]", e.message);
  process.exit(1);
});
