# tachibana-server

立花証券e支店APIにログインし、4つの役割（リアルタイム中継・HTTP問い合わせ応答・定時自動スキャンの起動・
寄り前気配の収集）を常時実行する、Railway上の常駐サーバーです。
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
  REQUEST I/F ←─────│ premarketLogger   │──POST(1日1回)───→ api/sync.js ──→ Redis
                    │  8:45〜9:06に15秒おき取得し、終了時にまとめて送る
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

`PORT`（既定8080）で待ち受け、ログイン済みセッションを使い回して次の5つをGETで提供します。
`TACHIBANA_RELAY_SECRET` が設定されている場合は `X-Relay-Secret` ヘッダを検証します（未設定なら常に許可）。

| パス | 内容 | サーバー側キャッシュ |
| --- | --- | --- |
| `/topix` | TOPIXの前日比% | 1時間（取得中のPromiseも共有し重複問い合わせを1回にまとめる） |
| `/issue-detail?code=XXXX` | PER/PBR/EPS/BPS/配当利回り・配当権利落日 | 銘柄ごとに1時間 |
| `/ranking-data` | 全銘柄の現在値・前日終値・出来高・会社名・業種 | 銘柄マスタ24時間 ＋ 価格3分 |
| `/names` | 銘柄コード→会社名のマップ | 24時間 |
| `/market-price?code=...&cols=...` | 立花の時価情報をそのまま返す（寄り前の板・気配の実測用） | なし（秒単位の変化を見るため） |

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

### premarketLogger（`premarketLogger.js`）— 寄り前気配の収集

平日8:45〜9:06（JST）に15秒おきで立花の時価情報を取得し、窓が閉じた時点でその日ぶんをまとめて
`api/sync.js?resource=premarket-log` へPOSTします。取得は `webapi.fetchBatchPrice()` を直接呼ぶ形で、
自分自身をHTTPで叩きません。立花の戻り値は一切加工せず、エラーも握りつぶさず同じ配列に積みます
（後から何が取れていたのかを検証するため）。対象銘柄は `PREMARKET_CODES`（既定 `7203` 1銘柄）、
1ティックを15秒に収めるため `PREMARKET_MAX`（既定8件）で件数に上限を掛けます。
立花の時価情報は1回の要求に載せる件数が多いと、超えたぶんが黙って切り捨てられて返ります。
そのため対象銘柄を `PREMARKET_CHUNK_SIZE`（既定80件）ずつに分割し、直列で取得して応答を連結します
（並列にすると通番が入れ替わって弾かれるため直列固定です）。
POSTに3回失敗した場合は、貯めたデータを失わないよう内容の全文をログへ出力します
（Railwayのログからコピーすれば手作業で復旧できます）。
生ログの保存に成功したときだけ、続けて `api/sync.js?resource=premarket-prediction&date=<日付>` を
1回だけPOSTし、その日の気配から寄り予想をVercel側に生成させます。リトライはせず、
失敗しても収集の成否には数えません（生ログは保存済みのため、あとから同じURLを手で叩けば作り直せます）。

## ファイル一覧

リポジトリ直下はサブフォルダの無いフラットな構成です。

| ファイル | 役割 |
| --- | --- |
| `index.js` | 起動口。上記4モジュールを読み込んで `start()` するだけ |
| `config.js` | 設定値の一元管理。`dotenv` の読み込みと必須変数のチェック（未設定なら起動時に例外） |
| `auth.js` | 立花e支店API v4r9のログイン・仮想URLの復号・`p_no` の採番とリトライ・日次の再ログイン判定 |
| `eventClient.js` | EVENT I/F（WebSocket）クライアント。1銘柄だけを購読して受信データを流す |
| `relay.js` | Vercel API経由での読み書き（購読中銘柄のGET／リアルタイム値のPOST） |
| `watcher.js` | リアルタイム中継の本体（上記） |
| `webapi.js` | HTTPサーバーの本体（上記） |
| `scanner.js` | 定時自動スキャンのスケジューラ（上記） |
| `premarketLogger.js` | 寄り前気配ロガーの本体（上記） |
| `holidays.js` | 日本市場の休場日判定（土日・祝日・振替休日・年末年始）。外部APIには問い合わせない |
| `verify-topix.js` | 検証用スクリプト。TOPIXが立花APIで代用できるかを確認する |
| `verify-tachibana-migration.js` | 検証用スクリプト。銘柄マスタ・銘柄詳細・日足・時価情報が取れるかを確認する |
| `verify-tachibana-ranking.js` | 検証用スクリプト。ランキング用データの絞り込み条件と一括取得の所要時間を計測する |
| `package.json` | 依存（`dotenv` / `iconv-lite` / `node-cron` / `ws`）と起動コマンド。Node.js 18以上 |
| `railway.json` | Railwayのビルド・起動設定（NIXPACKS / `node index.js` / 失敗時に最大10回再起動） |
| `.gitignore` | `node_modules/` と `.env` 系・ログを除外 |
| `README.md` | このファイル |

`verify-*.js` は通常運用では動きません。使う場合は `railway.json` の `startCommand` を一時的に
`node verify-xxx.js` へ変えてデプロイし、確認後に必ず `node index.js` へ戻してください
（戻さないと常駐処理が動かないままになります）。

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
| `VERCEL_API_BASE` | 任意（既定はVercelの本番URL） | scanner・premarketLoggerのPOST先ベースURL。末尾のスラッシュは除去される |
| `SCAN_ENABLED` | 任意（既定 `true`） | `false`（大文字小文字問わず）にすると定時自動スキャンを起動しない |
| `SCAN_TIMES` | 任意（既定は平日5回） | 自動スキャンの実行時刻。カンマ区切り・JST・月〜金。解釈できない要素は読み飛ばす |
| `SCAN_BATCH_SIZE` | 任意（既定 `5`） | 1バッチの銘柄数。上限5で丸められるため、下方向にしか変えられない |
| `PREMARKET_CODES` | 任意（既定は1銘柄） | 寄り前ロガーの対象銘柄コード。カンマ区切り。4桁英数字以外は除外する（`278A` のような英字入りコードも扱える） |
| `PREMARKET_MAX` | 任意（既定 `8`） | 寄り前ロガーの対象銘柄の総数の上限。先頭からこの件数だけを採用する。1回の取得要求に載せる件数を決めるものではない（それは `PREMARKET_CHUNK_SIZE`） |
| `PREMARKET_CHUNK_SIZE` | 任意（既定 `80`） | 1回の取得要求に載せる銘柄数の上限。立花APIの応答切り捨てを避けるための分割単位。対象銘柄をこの件数ずつに割り、直列で取得して連結する |

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
[webapi] HTTPサーバー起動。ポート: 8080
[scan] 起動しました。宛先: ... / バッチサイズ: 5 件
[premarket] 起動しました。8:45〜9:06(JST/平日) に15秒間隔で取得します。宛先: <VERCEL_API_BASE>
[premarket] 対象 120件 / 受領 150件 / 上限 120件 / 分割 80件 → 1234,5678,...
```

`[premarket] 対象 … / 受領 … / 上限 … / 分割 …` は、対象＝収集対象として組み立てた件数、
受領＝銘柄リストとして受け取った件数、上限＝`PREMARKET_MAX`、分割＝`PREMARKET_CHUNK_SIZE` です
（上の数値は書式を示すための例で、実際の値ではありません）。

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
