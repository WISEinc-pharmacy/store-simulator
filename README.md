# Store Simulator

薬局新店舗（越谷・清瀬）の収支シミュレーター。Firestore にデータを保存し、ブラウザで可視化する。

## セットアップ（seed.mjs を使う場合）

`seed.mjs` は Firestore にシナリオデータを投入するスクリプトです。実行前に認証情報を環境変数で設定する必要があります。

### 1. .env ファイルを作成

```bash
cp .env.example .env
```

### 2. .env を編集して実際の値を設定

```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
GOOGLE_REFRESH_TOKEN=1//xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: Google Cloud Console → APIとサービス → 認証情報 → OAuthクライアントID
- `GOOGLE_REFRESH_TOKEN`: merubo プロジェクトの OAuth フローで取得済みのリフレッシュトークン

> **.env は Git にコミットしないこと**（.gitignore 済み）

### 3. 実行

```bash
node seed.mjs
```

## 構成

| ファイル | 説明 |
|---|---|
| `index.html` | ダッシュボード（Firestore 読み込み） |
| `gantt.html` | 開局準備・スケジュール |
| `seed.html` | ブラウザからのデータ投入（Googleログイン使用） |
| `seed.mjs` | Node.js スクリプトからのデータ投入 |
