// TOPIXが立花証券APIで代用できるか確認するための検証スクリプト。
// 既存の auth.js（ログイン・セッション管理）をそのまま再利用します。
//
// 使い方（tachibana-serverフォルダ内に置いて実行）:
//   node verify-topix.js
//     → 指数マスタ一覧を表示し、名前に「TOPIX」を含む候補をハイライトします。
//   node verify-topix.js <銘柄コード>
//     → 指定コードで日足の蓄積データが取れるか確認します（①で見つけたコードを指定）。
//
// 例:
//   node verify-topix.js
//   node verify-topix.js 0000000

var auth = require("./auth");

async function listIndexMaster() {
  var session = await auth.ensureSession();
  var params = Object.assign(auth.nextHeader(), {
    sCLMID: "CLMMfdsGetMasterData",
    sTargetCLMID: "CLMIssueMstIndex",
  });
  var ans = await auth.postToServer(session.sUrlMaster, params);
  auth.checkAnswer(ans);

  var list = ans.CLMIssueMstIndex || [];
  console.log("[指数マスタ] 件数:", list.length);
  console.log("----------------------------------------");
  list.forEach(function (item) {
    var mark = String(item.sIssueName || "").indexOf("TOPIX") !== -1 ? " ★TOPIX候補" : "";
    console.log(item.sIssueCode, "\t", item.sIssueName, mark);
  });
  console.log("----------------------------------------");
  console.log("上の一覧から「★TOPIX候補」または名称にTOPIXを含む銘柄コードを控えてください。");
  console.log("その後 node verify-topix.js <控えたコード> を実行すると②の確認に進みます。");
}

async function checkHistory(issueCode) {
  var session = await auth.ensureSession();

  // まず sSizyouC:"00"（東証）で試し、ダメなら "01" でも試す
  var candidates = ["00", "01"];
  for (var i = 0; i < candidates.length; i++) {
    var sizyouC = candidates[i];
    var params = Object.assign(auth.nextHeader(), {
      sCLMID: "CLMMfdsGetMarketPriceHistory",
      sIssueCode: issueCode,
      sSizyouC: sizyouC,
    });
    console.log("[蓄積情報問合取得] sIssueCode=" + issueCode + " sSizyouC=" + sizyouC + " で試行中...");
    try {
      var ans = await auth.postToServer(session.sUrlPrice, params);
      auth.checkAnswer(ans);
      var hist = ans.aCLMMfdsMarketPriceHistory || [];
      if (hist.length > 0) {
        console.log("成功！ 件数:", hist.length);
        console.log("直近5件:");
        hist.slice(-5).forEach(function (h) {
          console.log(" ", h.sDate, "始:" + h.pDOP, "高:" + h.pDHP, "安:" + h.pDLP, "終:" + h.pDPP);
        });
        console.log("----------------------------------------");
        console.log("→ TOPIXの日足は立花証券APIで代用できます（sSizyouC=" + sizyouC + "）。");
        return;
      } else {
        console.log("応答は正常でしたが、データ件数が0件でした。");
      }
    } catch (e) {
      console.log("失敗:", e.message);
    }
  }
  console.log("----------------------------------------");
  console.log("→ 00/01どちらの市場コードでもデータが取れませんでした。");
  console.log("  銘柄コードの指定が違う可能性があります。①のマスタ一覧を再確認してください。");
}

async function main() {
  var arg = process.argv[2];
  if (!arg) {
    await listIndexMaster();
  } else {
    await checkHistory(arg);
  }
}

main().catch(function (e) {
  console.error("[エラー]", e.message);
  process.exit(1);
});
