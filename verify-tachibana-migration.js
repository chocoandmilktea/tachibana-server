// J-Quants→立花証券移行に向けた検証スクリプト（iPad/Railway向け）。
// 既存の auth.js（ログイン・セッション管理）をそのまま再利用します。
//
// 確認する内容:
//   ①銘柄マスタ一括取得（業種コード・会社名を全銘柄まとめて取れるか）
//   ②銘柄詳細情報問合取得（PER/PBR/EPS/BPS/配当利回りを複数銘柄まとめて取れるか）
//   ③日足蓄積データ（20年分の日足がサンプル1銘柄で取れるか）
//   ④時価情報問合取得（出来高・現在値の一括取得。情報コード一覧は別マニュアルにあり
//     今回未確認のため、候補コードをいくつか試して生データを出力します）
//
// 使い方: railway.json の startCommand を一時的に
//   "node verify-tachibana-migration.js" に変更してデプロイし、Deployments のログを見てください。
// 確認が終わったら、必ず startCommand を "node index.js" に戻してください
// （戻さないとリアルタイム中継(watcher)が動かないままになります）。

var auth = require("./auth");

var SAMPLE_CODES = ["7203", "6758", "9984", "8306", "6501"]; // トヨタ・ソニー・ソフトバンクG・三菱UFJ・日立

async function main() {
  var session = await auth.ensureSession();

  // ① 銘柄マスタ一括取得（業種コード・会社名）
  console.log("========== ① 銘柄マスタ一括取得（業種コード） ==========");
  try {
    var masterParams = Object.assign(auth.nextHeader(), {
      sCLMID: "CLMMfdsGetMasterData",
      sTargetCLMID: "CLMIssueMstKabu",
      sTargetColumn: "sIssueCode,sIssueName,sGyousyuCode,sGyousyuName",
    });
    var masterAns = await auth.postToServer(session.sUrlMaster, masterParams);
    auth.checkAnswer(masterAns);
    var list = masterAns.CLMIssueMstKabu || [];
    console.log("取得件数:", list.length);
    console.log("サンプル5件:");
    list.slice(0, 5).forEach(function (item) {
      console.log(" ", item.sIssueCode, item.sIssueName, "業種:", item.sGyousyuCode, item.sGyousyuName);
    });
    console.log(list.length > 0
      ? "→ 成功。全銘柄が一括で業種コード付きで取得できています。"
      : "→ 0件でした。要調査。");
  } catch (e) {
    console.log("失敗:", e.message);
  }

  // ② 銘柄詳細情報問合取得（PER/PBR/EPS/BPS/配当利回り、複数銘柄まとめて）
  console.log("");
  console.log("========== ② 銘柄詳細情報問合取得（PER/PBR/EPS/BPS/配当利回り） ==========");
  try {
    var detailParams = Object.assign(auth.nextHeader(), {
      sCLMID: "CLMMfdsGetIssueDetail",
      sTargetIssueCode: SAMPLE_CODES.join(","),
    });
    var detailAns = await auth.postToServer(session.sUrlMaster, detailParams);
    auth.checkAnswer(detailAns);
    var details = detailAns.aCLMMfdsIssueDetail || [];
    console.log("取得件数:", details.length, "/ 要求件数:", SAMPLE_CODES.length);
    details.forEach(function (d) {
      console.log(
        " ", d.sIssueCode,
        "PER:", d.pRPER, "PBR:", d.pSPBR,
        "EPS:", d.pEPSF, "BPS:", d.pBPSB,
        "配当利回り:", d.pSYIE
      );
    });
    console.log(details.length > 0
      ? "→ 成功。複数銘柄まとめてPER/PBR/EPS/BPS/配当利回りが取得できています。"
      : "→ 0件でした。要調査。");
  } catch (e) {
    console.log("失敗:", e.message);
  }

  // ③ 日足蓄積データ（20年分、サンプル1銘柄）
  console.log("");
  console.log("========== ③ 日足蓄積データ（20年分、サンプル:" + SAMPLE_CODES[0] + "） ==========");
  try {
    var histParams = Object.assign(auth.nextHeader(), {
      sCLMID: "CLMMfdsGetMarketPriceHistory",
      sIssueCode: SAMPLE_CODES[0],
      sSizyouC: "00",
    });
    var histAns = await auth.postToServer(session.sUrlPrice, histParams);
    auth.checkAnswer(histAns);
    var hist = histAns.aCLMMfdsMarketPriceHistory || [];
    console.log("取得件数:", hist.length, "（1日1件なので、営業日換算で約", Math.round(hist.length / 245), "年分）");
    if (hist.length > 0) {
      console.log("最古:", hist[0].sDate, "/ 最新:", hist[hist.length - 1].sDate);
    }
  } catch (e) {
    console.log("失敗:", e.message);
  }

  // ④ 時価情報問合取得（出来高・現在値の一括取得。情報コードは未確定のため探索的に試す）
  console.log("");
  console.log("========== ④ 時価情報問合取得（出来高・現在値、情報コード探索） ==========");
  console.log("※情報コード一覧は別マニュアル（EVENT I/F データ仕様）にあり未確認のため、候補をいくつか試します。");
  var candidateColumns = ["pDPP", "tDPP:T", "pPRP", "pDV", "tDV:T"];
  try {
    var priceParams = Object.assign(auth.nextHeader(), {
      sCLMID: "CLMMfdsGetMarketPrice",
      sTargetIssueCode: SAMPLE_CODES.join(","),
      sTargetColumn: candidateColumns.join(","),
    });
    var priceAns = await auth.postToServer(session.sUrlPrice, priceParams);
    auth.checkAnswer(priceAns);
    var prices = priceAns.aCLMMfdsMarketPrice || [];
    console.log("取得件数:", prices.length);
    console.log("生データ（現在値・出来高らしき値がどの項目に入っているか目で確認してください）:");
    prices.forEach(function (p) {
      console.log(" ", JSON.stringify(p));
    });
  } catch (e) {
    console.log("失敗:", e.message, "→ この項目指定では取得できませんでした。");
  }

  console.log("");
  console.log("========== 確認終了 ==========");
  console.log("結果を確認できたら、railway.json の startCommand を \"node index.js\" に戻してください。");
}

main().catch(function (e) {
  console.error("[エラー]", e.message);
  process.exit(1);
});
