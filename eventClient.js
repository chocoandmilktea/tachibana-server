// 立花証券 EVENT I/F (WebSocket版) クライアント
// 選択中の1銘柄だけをリアルタイム購読し、受信データをコールバックに渡す。
//
// 注意: p_board_no / p_gyou_no / p_evt_cmd の詳細な意味は公式マニュアルの
// 「EVENT I/F 利用方法、データ仕様」に記載されています。ここでは公式サンプル
// (e_api_sample_v4r9.py) と同じデフォルト値を踏襲していますが、実際に届く
// データを見ながら調整してください（onData に生データも渡しています）。

var WebSocket = require("ws");
var EventEmitter = require("events");

class TachibanaEventClient extends EventEmitter {
  constructor(sUrlEventWebSocket, mktCode) {
    super();
    this.baseUrl = sUrlEventWebSocket;
    this.mktCode = mktCode;
    this.ws = null;
    this.currentTicker = null;
    this._closedByUs = false;
  }

  // 購読銘柄を切り替える（内部でいったん切断→再接続）
  subscribe(ticker) {
    if (this.currentTicker === ticker && this.ws && this.ws.readyState === WebSocket.OPEN) return;
    this.currentTicker = ticker;
    this._connect(ticker);
  }

  stop() {
    this._closedByUs = true;
    this.currentTicker = null;
    if (this.ws) this.ws.close();
  }

  _connect(ticker) {
    if (this.ws) {
      this._closedByUs = true; // 古い接続のcloseイベントで再接続しないようにする
      this.ws.close();
    }
    this._closedByUs = false;

    var params = new URLSearchParams({
      p_rid: "21",
      p_board_no: "0",
      p_gyou_no: "1",
      p_issue_code: ticker,
      p_mkt_code: this.mktCode,
      p_eno: "0",
      p_evt_cmd: "ST,KP,FD",
    });
    var url = this.baseUrl + "?" + params.toString();

    var self = this;
    var ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", function () {
      self.emit("open", ticker);
    });

    ws.on("message", function (data) {
      var text = data.toString("ascii");
      self._parseAndEmit(text, ticker);
    });

    ws.on("close", function () {
      if (!self._closedByUs && self.currentTicker === ticker) {
        // 意図しない切断。3秒後に再接続を試みる
        setTimeout(function () {
          if (self.currentTicker === ticker) self._connect(ticker);
        }, 3000);
      }
    });

    ws.on("error", function (err) {
      self.emit("error", err);
    });
  }

  // \x01区切りのレコード、\x02区切りのcol/valペアを解析する
  _parseAndEmit(rawText, ticker) {
    var records = rawText.split("\x01");
    var fields = {};
    records.forEach(function (rec) {
      if (!rec) return;
      var parts = rec.split("\x02");
      if (parts.length >= 2) fields[parts[0]] = parts[1];
    });
    this.emit("data", { ticker: ticker, fields: fields, raw: rawText });
  }
}

module.exports = TachibanaEventClient;
