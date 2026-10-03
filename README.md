# tachibana-server

立花証券e支店APIにログインし、4つの役割（リアルタイム中継・HTTP問い合わせ応答・定時自動スキャンの起動・
場中の板情報の記録）を常時実行する、Railway上の常駐サーバーです。
Redisには直接繋がず、すべての読み書きをVercel側の `api/sync.js` 経由で行うため、
このサーバー自体はRedisの認証情報を持ちません。
フロントエンド側のリポジトリ `daytrade-simulator`（Vercel）と対で動作します。

```
                    tachibana-server (Railway・常時起動)
                    ┌───────────────────┐
[立花証券 e支店API]  │                   │   [Vercel]         [Upstash Redis]
                    │                   │
  EVENT I/F  ←─WS──→│ watcher           │──POST(5秒おき)──→ api/sync.js ──→ Redis
                    │                   │←─GET(3秒おき)──── api/sync.js ←── Redis
                    │                   │
  REQUEST I/F ←─────│ webapi            │←─────GET───────── Vercel側のAPI
                    │  (PORTで待受)      │
                    │                   │
                    │ scanner           │──POST(平日5回)──→ api/sync.js
                    │                   │   scan-run が完走するまで繰り返す
                    │                   │
  REQUEST I/F ←─────│ bookLogger        │──PUT(1時間ごと)──→ GitHub（daytrade-data）
                    │  場中に1分おき取得し、時ごとに CSV.gz で保存
                    └───────────────────┘
```

## このサーバーの4つの役割

`index.js` が起動時に読み込むのは次の4モジュールだけです。いずれも常駐し、互いに独立して動きます。

### watcher（`watcher.js`）— 選択中1銘柄のリアルタイム中継

Vercel側の「今フロントで選択中の銘柄」を `WATCH_POLL_INTERVAL_SECONDS`（既定3秒）おきに確認し、
銘柄が変わったら立花のEVENT I/F（WebSocket）の購読を切り替えます。受信した現在値・板情報は
`QUOTE_WRITE_MIN_INTERVAL_SECONDS`（既定5秒）おきに間引いてVercelへ書き戻します。
購読要求が `WATCH_STALE_SECONDS`（既定120秒）より古くなったら「誰も見ていない」とみなして接続を切ります。
EVENT I/Fは変化した項目だけを送ってくるため、受信データは丸ごと置き換えず既存の値へマージしています
（置き換えると気配値が消えるため）。毎日8:35（メンテナンス明け）に自動で再ログインし、
セッションエラーを検知した場合もその場で再ログインして接続を張り直します。

### webapi（`webapi.js`）— Vercelからの問い合わせに応えるHTTPサーバー

`PORT`（既定8080）で待ち受け、ログイン済みセッションを使い回して次の4つをGETで提供します。
`TACHIBANA_RELAY_SECRET` が設定されている場合は `X-Relay-Secret` ヘッダを検証します（未設定なら常に許可）。

| パス | 内容 | サーバー側キャッシュ |
| --- | --- | --- |
| `/topix` | TOPIXの前日比% | 1時間（取得中のPromiseも共有し重複問い合わせを1回にまとめる） |
| `/issue-detail?code=XXXX` | PER/PBR/EPS/BPS/配当利回り・配当権利落日 | 銘柄ごとに1時間 |
| `/ranking-data` | 全銘柄の現在値・前日終値・出来高・会社名・業種 | 銘柄マスタ24時間 ＋ 価格3分 |
| `/names` | 銘柄コード→会社名のマップ | 24時間 |

`/ranking-data` は銘柄マスタから業種コード9999（その他。ETF/REIT等）を除いた実株式のみを対象とし、
120件ずつ・5並列で取得します。

### scanner（`scanner.js`）— 定時自動スキャンの起動

`SCAN_TIMES`（既定 8:50 / 9:30 / 11:00 / 13:00 / 15:00・JST・月〜金）に、Vercelの
`api/sync.js?resource=scan-run` を `nextOffset` が返らなくなるまで繰り返しPOSTします。
**このファイルが担当するのは時計とループ制御だけで、株価取得もスコア計算も一切行いません**（計算はVercel側）。
1バッチ5件・直列（前の応答を待ってから次）で、バッチ間に1秒あけます。5件固定なのはVercel Hobbyの
関数タイムアウト10秒に対する実測値（5件で4.5秒、8件はタイムアウト）によるもので、`SCAN_BATCH_SIZE` を
大きくしても `MAX_BATCH_SIZE = 5` で丸められます。scan-runはRedisのread-modify-writeのため、
`running` フラグで前のスロットと重ならないよう排他しています。
土日・祝日・年末年始（`holidays.js` の日付判定）はバッチを1回も投げません。
総実行15分・400バッチ・同一offsetの3回連続を上限として、いずれかに達したら中断します。

### bookLogger（`bookLogger.js`）— 場中の板情報の記録

場中の板情報を記録し、30営業日ほど貯めてから「1分後・5分後・30分後に上がっているか」との関係を
検証するための材料を作ります。**売買にも画面表示にも使いません。**
`BOOK_GITHUB_TOKEN` が未設定なら起動せず、そのことをログに1行出すだけです。

- **記録の時間帯**: 平日の 9:00〜11:30 と 12:30〜15:30（両端を含む）に1分おき。
  node-cron で毎分起動し、時間外なら取得しません。休場日は `holidays.js` の判定で飛ばします。
  前の回が終わっていなければ、その回は飛ばしてログに残します
- **対象銘柄**: 平日 15:35 に、銘柄マスタ（`webapi.getRankingMaster()`）の全銘柄について売買代金（`pDJ`）と
  現在値（`pDPP`）を取り、売買代金の大きい順に上位500銘柄を選んで「翌営業日」のリストにします。
  起動時はその日のリストを daytrade-data から読み戻し、15:35 より後の起動で翌営業日のリストが無ければすぐ選びます。
  場中に起動してリストがどこにも無い場合は、その時点の売買代金で選び、リストの `method` に `intraday` と残します
- **問い合わせ**: `webapi.fetchBatchPrice()` を100銘柄ずつ直列で呼びます。毎回、要求件数と応答件数を照合し、
  欠けた銘柄コードをログに出します（同じ欠け方が続く間は最初の1回だけ）。
  全項目での問い合わせがエラーになった回は、その回だけ下の16項目（`fallback16`）に切り替えて記録を続けます
- **項目**（立花の EVENT I/F 資料の情報コード。問い合わせ時は値に `p`、時刻に `t` を付ける。例: `pGAP1`・`tDPP:T`）

| ファイル種別 | 間隔 | 項目 |
| --- | --- | --- |
| `5m` | 5分おき（9:00, 9:05…）。59項目 | 値動き: DPP, DPP:T, PRP, DOP, DHP, DLP, DV, DJ, VWAP ／ 板の手前: QAP, QAS, AV, QBP, QBS, BV, AAV, ABV, QOV, QUV ／ 板の奥: GAP1〜10, GAV1〜10, GBP1〜10, GBV1〜10 |
| `1m` | 1分おき。15項目 | DPP, DPP:T, DV, DJ, VWAP, QAP, QAS, AV, QBP, QBS, BV, AAV, ABV, QOV, QUV |
| （切替時） | エラーの回だけ。16項目 | DPP, PRP, DV, DOP, DHP, DLP, QAS, QBS, AAV, ABV, GAP1, GBP1, GAV1, GBV1, QOV, QUV |

  5分の区切りの回は 5m の項目で1回だけ問い合わせ、その結果から 1m と 5m の両方の行を作ります。
  起動後に各項目セットを初めて使った回に、全銘柄で空だった項目名を一覧でログに出します

- **保存先**: `BOOK_GITHUB_REPO`（既定 `chocoandmilktea/daytrade-data`）へ GitHub の Contents API で書きます

| パス | 内容 |
| --- | --- |
| `data/book/1m/年/年-月-日/時.csv.gz` | 1分おきの記録 |
| `data/book/5m/年/年-月-日/時.csv.gz` | 5分おきの記録 |
| `data/book/targets/年/年-月-日.csv` | その日に使う対象リスト。列は `code, dj, rank, selected_at, method`（`after_close` または `intraday`） |

  時は2桁（`09`〜`15`）。11:30 の回は `11`、15:30 の回は `15` のファイルに入ります。
  CSV は UTF-8・先頭行が列名・gzip 圧縮で、各行の先頭に `time`（その100銘柄の問い合わせ開始時刻 HH:MM:SS）・
  `code`・`cols`（`full` / `front` / `fallback16` のどれで取ったか）を置き、続けて項目の値を立花の応答のまま入れます
  （列名は問い合わせ時の名前。値が無い項目は空）。
  時が変わったら前の時の分を、11:30 と 15:30 の回の後はその時の分をすぐ書きます。
  **同じパスにファイルが既にあれば書きません（書き換えない決まり）。** 書き込みに失敗したらメモリに残して次の回に再試行し、
  その日の 16:00 になっても書けなければログに残して破棄します。GitHub への通信はすべて15秒でタイムアウトします
- **ログ**: 正常時は1時間に1行の要約（回数・平均件数・飛ばした回数・書き出したファイル）。異常時はその都度出します

## ファイル一覧

リポジトリ直下はサブフォルダの無いフラットな構成です。

| ファイル | 役割 |
| --- | --- |
| `index.js` | 起動口。上記4モジュールを読み込んで `start()` するだけ |
| `config.js` | 設定値の一元管理。`dotenv` の読み込みと必須変数のチェック（未設定なら起動時に例外） |
| `auth.js` | 立花e支店API v4r10のログイン・仮想URLの復号・`p_no` の採番とリトライ・日次の再ログイン判定 |
| `eventClient.js` | EVENT I/F（WebSocket）クライアント。1銘柄だけを購読して受信データを流す |
| `relay.js` | Vercel API経由での読み書き（購読中銘柄のGET／リアルタイム値のPOST） |
| `watcher.js` | リアルタイム中継の本体（上記） |
| `webapi.js` | HTTPサーバーの本体（上記） |
| `scanner.js` | 定時自動スキャンのスケジューラ（上記） |
| `bookLogger.js` | 場中の板情報の記録（上記） |
| `holidays.js` | 日本市場の休場日判定（土日・祝日・振替休日・年末年始）。外部APIには問い合わせない |
| `package.json` | 依存（`dotenv` / `iconv-lite` / `node-cron` / `ws`）と起動コマンド。Node.js 18以上 |
| `railway.json` | Railwayのビルド・起動設定（NIXPACKS / `node index.js` / 失敗時に最大10回再起動） |
| `.gitignore` | `node_modules/` と `.env` 系・ログを除外 |
| `README.md` | このファイル |

## 環境変数

**値はここに書きません。** Railwayの「Variables」タブに登録してください。

| 変数名 | 必須・任意 | 用途 |
| --- | --- | --- |
| `TACHIBANA_ENV` | 任意（既定 `demo`） | `production` を指定したときだけ本番環境。それ以外の値・未設定はすべてデモ環境として扱う |
| `TACHIBANA_URL_AUTH_DEMO` | デモ時は必須 | デモ環境のログインURL。デモ時に未設定なら起動しない |
| `TACHIBANA_URL_AUTH_PROD` | 本番時は必須 | 本番環境のログインURL。本番時に未設定なら起動しない |
| `TACHIBANA_AUTH_ID` | 必須 | 立花証券e支店APIのログインID |
| `TACHIBANA_PRIVATE_KEY` | 必須 | 仮想URLの復号に使う秘密鍵（PEM・複数行のままでよい） |
| `TACHIBANA_MKT_CODE` | 任意（既定 `00`） | 市場コード |
| `TACHIBANA_WATCH_API` | 必須 | Vercel側の購読情報を読むURL（`api/sync.js` の `tachibana-watch`） |
| `TACHIBANA_QUOTE_API` | 必須 | Vercel側へリアルタイム値を書き込むURL（`api/sync.js` の `tachibana-quote`） |
| `TACHIBANA_RELAY_SECRET` | 任意（既定は空） | Vercelとの共有の合言葉。送信時は `X-Relay-Secret` ヘッダに付け、webapiでは受信時に照合する。空なら付与も照合もしない |
| `WATCH_STALE_SECONDS` | 任意（既定 `120`） | 購読要求がこの秒数より古くなったら「誰も見ていない」とみなして接続を切る |
| `QUOTE_WRITE_MIN_INTERVAL_SECONDS` | 任意（既定 `5`） | リアルタイム値をVercelへ書き戻す間隔（間引き） |
| `WATCH_POLL_INTERVAL_SECONDS` | 任意（既定 `3`） | 「今どの銘柄を見ているか」を確認する間隔 |
| `TACHIBANA_SEND_GAP_MS` | 任意（既定 `15`） | 立花APIへの送信と次の `p_no` 採番の間隔（ms）。後述の通番エラー対策 |
| `TACHIBANA_RETRY_GAP_MS` | 任意（既定 `150`） | 通番エラーでリトライする際の間隔（ms） |
| `PORT` | 任意（既定 `8080`） | webapiのHTTPサーバーの待ち受けポート。Railwayが自動で注入する |
| `VERCEL_API_BASE` | 任意（既定はVercelの本番URL） | scannerのPOST先ベースURL。末尾のスラッシュは除去される |
| `SCAN_ENABLED` | 任意（既定 `true`） | `false`（大文字小文字問わず）にすると定時自動スキャンを起動しない |
| `SCAN_TIMES` | 任意（既定は平日5回） | 自動スキャンの実行時刻。カンマ区切り・JST・月〜金。解釈できない要素は読み飛ばす |
| `SCAN_BATCH_SIZE` | 任意（既定 `5`） | 1バッチの銘柄数。上限5で丸められるため、下方向にしか変えられない |
| `BOOK_GITHUB_TOKEN` | 任意（未設定なら板の記録は起動しない） | 板の記録の書き込み先リポジトリに Contents API で書くための GitHub トークン（そのリポジトリの Contents の書き込み権限が必要） |
| `BOOK_GITHUB_REPO` | 任意（既定 `chocoandmilktea/daytrade-data`） | 板の記録の書き込み先リポジトリ（`owner/repo`）。既定ブランチに書く |

変数ごとの詳細な参照箇所（ファイル・行・未設定時の挙動）は、`daytrade-simulator` リポジトリの
`docs/ENV_AUDIT.md` にまとまっています。

## Railway での運用

Node.js 18以上が必要です（標準の `fetch` を使用しています）。

1. 立花証券e支店の「お客様情報＞設定情報＞e支店・API利用設定」から、
   認証ID（`e_api_authid.txt`）と秘密鍵（`e_api_private_key.pem`）を取得しておく
2. [Railway](https://railway.app) で「New Project」→「Deploy from GitHub repo」を選び、このリポジトリを選択
3. 「Variables」タブで上表の環境変数を1つずつ登録する
   （`TACHIBANA_PRIVATE_KEY` は複数行のままペーストしてOK）
4. `TACHIBANA_RELAY_SECRET` はVercel側の同名変数と同じ値にする（なりすまし防止。空でも動作はします）
5. `railway.json` を同梱済みなので、ビルド・起動コマンドの追加設定は不要
6. デプロイ後、「Deployments」のログに4モジュールの起動行が出ていれば成功

```
[watcher] 起動しました。ポーリング間隔: 3 秒 / 書き込み間隔: 5 秒
[scan] 起動しました。宛先: ... / バッチサイズ: 5 件
[book] 起動しました。平日 9:00〜11:30・12:30〜15:30(JST) に1分おき・100件ずつ取得します。保存先: ... / 項目数 full 59・front 15
[webapi] HTTPサーバー起動。ポート: 8080
```

`BOOK_GITHUB_TOKEN` が未設定の場合、`[book]` の行は「BOOK_GITHUB_TOKEN が未設定のため、板の記録は起動しません」になります。

（上の数値は書式を示すための例です。実際の値は環境変数の設定によって変わります）。

フロント側で銘柄を選択すると `[watcher] 監視銘柄を切り替え` が出て、購読が始まります。
データの中身（`fields`）は列コードをキーとした生データです。列コードの意味は立花証券の公式マニュアル
「EVENT I/F 利用方法、データ仕様」を参照してください。

本番環境へ切り替えるときは `TACHIBANA_ENV` を `production` にし、`TACHIBANA_AUTH_ID` /
`TACHIBANA_PRIVATE_KEY` を本番用のものに差し替えてください。

Railwayのコンテナは再起動のたびにファイルシステムがリセットされるため、
`session.json`（当日分のログイン情報）は再起動後に失われますが、
その場合は自動的に再ログインするだけなので問題ありません。

ローカルで動かす場合は `npm install` のあと、リポジトリ直下に `.env` を作って上表の変数を書き、
`npm start` で起動します（`config.js` が `dotenv` を読み込みます。`.env` は `.gitignore` 済みです）。

## 通番（p_no）エラーが出るときの調整

立花証券APIは「リクエストの `p_no` がサーバー到着順に増えていること」を要求します。
本サーバーは `auth.request()` で採番と送信開始を直列化し、
`p_errno=6`（通番エラー）が返った場合は採番し直して最大2回リトライします。

それでもRailwayのログに `p_errno=6` が残る場合は、次の環境変数で間隔を広げてください
（いずれも任意。単位はミリ秒）。

- `TACHIBANA_SEND_GAP_MS`（既定 `15`）… 送信と次の採番の間隔。
  ネットワークの揺らぎより大きくする必要があります。大きくすると通番エラーは減りますが、
  多数の銘柄を一括取得するときの所要時間が延びます（200件なら `15` で約3秒）。
- `TACHIBANA_RETRY_GAP_MS`（既定 `150`）… リトライ時の間隔。

## セキュリティ上の注意

- 認証ID・秘密鍵は**Railwayの「Variables」以外に一切置かないでください**。
  Gitリポジトリにコミットしない、`.gitignore` に `.env` を必ず入れる。
  ローカルに `.env` を作った場合も、その端末の外へ出さないこと。
- Redis経由ではなくVercel APIとだけ通信するため、Railway側にはRedisの認証情報は不要です。
  `TACHIBANA_RELAY_SECRET`（合言葉）だけ、他人に推測されにくい値にしてください。
