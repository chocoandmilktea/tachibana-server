// 立花証券 EVENT I/F (WebSocket版) クライアント
// 選択中の1銘柄だけをリアルタイム購読し、受信データをコールバックに渡す。
//
// 注意: p_board_no / p_gyou_no / p_evt_cmd の詳細な意味は公式マニュアルの
// 「EVENT I/F 利用方法、データ仕様」に記載されています。ここでは公式サンプル
// (e_api_sample_v4r10.py) と同じデフォルト値を踏襲していますが、実際に届く
// データを見ながら調整してください（onData に生データも渡しています）。

var WebSocket = require("ws");
var EventEmitter = require("events");
var accessGate = require("./accessGate");

// 意図しない切断・接続できなかったときの再接続の待ち時間。
// 失敗が続くたびに 3秒 → 6秒 → 12秒…と倍にし、最大5分。データを受け取れたら3秒に戻す。
// 以前は3秒固定だったため、立花が閉まっている間も3秒おきに接続を試み続けていた
var RECONNECT_BASE_MS = 3 * 1000;
var RECONNECT_MAX_MS = 5 * 60 * 1000;

class TachibanaEventClient extends EventEmitter {
  constructor(sUrlEventWebSocket, mktCode) {
    super();
    this.baseUrl = sUrlEventWebSocket;
    this.mktCode = mktCode;
    this.ws = null;
    this.currentTicker = null;
    this._closedByUs = false;
    this._reconnectDelayMs = RECONNECT_BASE_MS; // 次に再接続するまでの待ち時間
    this._reconnectTimer = null;
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
    this._clearReconnect();
    if (this.ws) this.ws.close();
  }

  // 今の接続を「意図しない切断」として切る。再接続は下の待ち時間（倍々）に従う。
  // watcher がエラー応答を受けたときに、ログインせずに接続だけ切るために使う
  dropConnection() {
    if (this.ws) this.ws.close();
  }

  _clearReconnect() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
  }

  // 待ち時間をあけて再接続する。呼ぶたびに次の待ち時間を倍にする（最大5分）
  _scheduleReconnect(ticker) {
    var self = this;
    var delay = this._reconnectDelayMs;
    this._reconnectDelayMs = Math.min(delay * 2, RECONNECT_MAX_MS);
    this._clearReconnect();
    this._reconnectTimer = setTimeout(function () {
      self._reconnectTimer = null;
      if (self.currentTicker === ticker) self._connect(ticker);
    }, delay);
  }

  _connect(ticker) {
    this._clearReconnect();
    if (this.ws) {
      this._closedByUs = true; // 古い接続のcloseイベントで再接続しないようにする
      this.ws.close();
      this.ws = null;
    }
    this._closedByUs = false;

    // 立花へ接続してよいか（休場日・3:00〜8:35・一時停止中は接続しない）。
    // 止めた理由のログは accessGate が切り替わり時に1回だけ出すので、ここでは出さない。
    // 送れるようになったら拾えるよう、待ち時間をあけて判定し直す
    if (accessGate.check(Date.now())) {
      this._scheduleReconnect(ticker);
      return;
    }

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
      // 張り直した後に古い接続のcloseが届いても、再接続を重ねて予約しない
      if (self.ws !== ws) return;
      if (!self._closedByUs && self.currentTicker === ticker) {
        // 意図しない切断。待ち時間（3秒から倍々・最大5分）をあけて再接続を試みる
        self._scheduleReconnect(ticker);
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

    // p_errnoが"0"以外＝セッション切れ等のエラー応答。株価データとして扱わず別イベントで通知する
    if (fields.p_errno && fields.p_errno !== "0") {
      this.emit("sessionError", { ticker: ticker, fields: fields, raw: rawText });
      return;
    }

    // データを受け取れた＝接続は正常なので、再接続の待ち時間を3秒に戻す
    this._reconnectDelayMs = RECONNECT_BASE_MS;
    this.emit("data", { ticker: ticker, fields: fields, raw: rawText });
  }
}

module.exports = TachibanaEventClient;
