// TOPIXが立花証券APIで代用できるか確認するための検証スクリプト（iPad/Railway向け）。
// 既存の auth.js（ログイン・セッション管理）をそのまま再利用します。
//
// 実行すると自動で以下を1回で行います:
//   ①指数マスタ一覧を取得し、名称に「TOPIX」を含む銘柄を自動検出
//   ②見つかった銘柄コードで日足の蓄積データが実際に取れるか確認
// 結果はすべて console.log でRailwayのログに出力されます。
//
// 使い方: railway.json の startCommand を一時的に
//   "node verify-topix.js" に変更してデプロイし、Deploymentsのログを見てください。
// 確認が終わったら、必ず startCommand を "node index.js" に戻してください
// （戻さないとリアルタイム中継(watcher)が動かないままになります）。

var auth = require("./auth");

async function main() {
  var session = await auth.ensureSession();

  // ① 指数マスタから TOPIX を自動検出
  console.log("========== ① 指数マスタ取得 ==========");
  var masterParams = Object.assign(auth.nextHeader(), {
    sCLMID: "CLMMfdsGetMasterData",
    sTargetCLMID: "CLMIssueMstIndex",
  });
  var masterAns = await auth.postToServer(session.sUrlMaster, masterParams);
  auth.checkAnswer(masterAns);

  var list = masterAns.CLMIssueMstIndex || [];
  console.log("指数マスタ件数:", list.length);
  list.forEach(function (item) {
    console.log(" ", item.sIssueCode, "\t", item.sIssueName);
  });

  var topixItem = list.filter(function (item) {
    return String(item.sIssueName || "").indexOf("TOPIX") !== -1;
  });

  if (topixItem.length === 0) {
    console.log("----------------------------------------");
    console.log("結果: 指数マスタの中に「TOPIX」を含む銘柄名が見つかりませんでした。");
    console.log("→ 上の一覧を目で見て、TOPIXに相当しそうな銘柄コードがないか確認してください。");
    return;
  }

  console.log("----------------------------------------");
  console.log("TOPIX候補:", topixItem.length, "件見つかりました。順番に②を試します。");

  // ② 見つかった候補それぞれで日足の蓄積データ取得を試す
  for (var i = 0; i < topixItem.length; i++) {
    var code = topixItem[i].sIssueCode;
    var name = topixItem[i].sIssueName;
    console.log("========== ② 日足取得確認: " + code + " (" + name + ") ==========");

    var candidates = ["00", "01"];
    var success = false;
    for (var j = 0; j < candidates.length; j++) {
      var sizyouC = candidates[j];
      var histParams = Object.assign(auth.nextHeader(), {
        sCLMID: "CLMMfdsGetMarketPriceHistory",
        sIssueCode: code,
        sSizyouC: sizyouC,
      });
      console.log("試行: sIssueCode=" + code + " sSizyouC=" + sizyouC);
      try {
        var histAns = await auth.postToServer(session.sUrlPrice, histParams);
        auth.checkAnswer(histAns);
        var hist = histAns.aCLMMfdsMarketPriceHistory || [];
        if (hist.length > 0) {
          console.log("成功！ 件数:", hist.length);
          console.log("直近5件:");
          hist.slice(-5).forEach(function (h) {
            console.log("  ", h.sDate, "始:" + h.pDOP, "高:" + h.pDHP, "安:" + h.pDLP, "終:" + h.pDPP);
          });
          console.log("→ この銘柄コード(" + code + ")・sSizyouC=" + sizyouC + " でTOPIX日足は代用可能です。");
          success = true;
          break;
        } else {
          console.log("応答は正常でしたが、データ件数が0件でした。");
        }
      } catch (e) {
        console.log("失敗:", e.message);
      }
    }
    if (!success) {
      console.log("→ この銘柄コードでは日足を取得できませんでした。");
    }
    console.log("");
  }

  console.log("========== 確認終了 ==========");
  console.log("結果を確認できたら、railway.json の startCommand を \"node index.js\" に戻してください。");
}

main().catch(function (e) {
  console.error("[エラー]", e.message);
  process.exit(1);
});
