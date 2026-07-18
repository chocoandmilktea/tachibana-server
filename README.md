# tachibana-server

立花証券e支店APIにログインし、フロント（App.js）で選択中の1銘柄のリアルタイム株価・板情報を
取得して、既存の Upstash Redis 経由でVercel API（フロント側）に中継する常駐サーバーです。

```
[立花証券 EVENT I/F(WebSocket)] ←常時接続— [このサーバー]
                                                 ↓ 書き込み(5秒おきに間引き)
                                          [Upstash Redis]（sync.jsと共用）
                                                 ↑ 読み込み
                    [Vercel: api/tachibana-quote.js] ← App.jsが7秒おきに取得
```

## 1. 事前準備

- 立花証券e支店の「お客様情報＞設定情報＞e支店・API利用設定」から、
  認証ID(`e_api_authid.txt`)と秘密鍵(`e_api_private_key.pem`)を取得してください。
- まずは **デモ環境**（`TACHIBANA_ENV=demo`）で動作確認することを強く推奨します。
  本番環境は実際の口座に接続されます。

## GitHubへの追加方法（ターミナル不要・iPad等）

1. github.com にログイン →「New repository」→ 名前を`tachibana-server`にして作成
   （「Add a README」等のチェックは入れず空の状態で作成）
2. 作成後に出る画面の「uploading an existing file」というリンクをタップ
3. このフォルダの中身（`index.js`, `package.json`, `railway.json`, `.gitignore`,
   `.env.example`, `README.md`, `auth.js`, `config.js`, `eventClient.js`,
   `redis.js`, `watcher.js`）を、Filesアプリから複数選択してドラッグ＆ドロップ
   （または「choose your files」から選択）
4. 下部の「Commit changes」をタップすればアップロード完了

サブフォルダが無い構成にしてあるので、ファイルを個別に選ぶだけでOKです。

## 2. セットアップ（VPS上）

```bash
git clone <このディレクトリをリポジトリ化したもの>
cd tachibana-server
npm install
cp .env.example .env
# .env を編集して、認証ID・秘密鍵・Upstashの接続情報を入力してください
```

Node.js 18以上が必要です（標準の `fetch` を使用しています）。

## 3. 動作確認

```bash
npm start
```

`[watcher] 起動しました` のログが出ればOKです。フロント側で銘柄を選択すると
`[watcher] 監視銘柄を切り替え` のログが出て、購読が始まります。

データの中身（`fields`）は銘柄コードごとの列コードをキーとした生データです。
実際に届く内容を見ながら、`eventClient.js` の購読パラメータ（`p_board_no` /
`p_gyou_no` / `p_evt_cmd` など）や、フロント側の表示項目を調整してください。
詳細な列コードの意味は立花証券の公式マニュアル「EVENT I/F 利用方法、データ仕様」を
参照してください。

## 4. 常時起動させる

### 方法A: Railway（推奨）

1. このフォルダ（`tachibana-server/`）をGitHubリポジトリにpushする
   （`.env`は`.gitignore`済みなのでアップロードされません）
2. [Railway](https://railway.app) で「New Project」→「Deploy from GitHub repo」を選び、
   このリポジトリを選択
3. 「Variables」タブで `.env.example` の中身を1つずつ登録する
   （`TACHIBANA_PRIVATE_KEY` は複数行のままペーストしてOK）
4. デプロイ完了後、「Deployments」→ログで `[watcher] 起動しました` が出ていれば成功
5. `railway.json` を同梱済みなので、ビルド・起動コマンドの追加設定は不要です

Railwayのコンテナは再起動のたびにファイルシステムがリセットされるため、
`session.json`（当日分のログイン情報）は再起動後に失われますが、
その場合は自動的に再ログインするだけなので問題ありません。

### 方法B: VPS + pm2

```bash
npm install -g pm2
pm2 start index.js --name tachibana-server
pm2 save
pm2 startup   # 表示されるコマンドを実行するとVPS再起動後も自動起動します
```

## 5. 本番環境への切り替え

`.env` の `TACHIBANA_ENV=production` に変更し、`TACHIBANA_AUTH_ID` /
`TACHIBANA_PRIVATE_KEY` を本番用のものに差し替えてください。

## セキュリティ上の注意

- `.env`（認証ID・秘密鍵）は**このVPS以外に一切置かないでください**。
  Gitリポジトリにコミットしない、`.gitignore` に `.env` を必ず入れる。
- Redisに書き込む内容は株価・板情報のみで、認証情報は含みません。
