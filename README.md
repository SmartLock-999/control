# 遠端控制面板

基於 React + Vite + Supabase + MQTT 的遠端設備控制介面。

---

## 🚀 部署到 GitHub Pages

### 第一步：設定 GitHub Secrets

進入你的 GitHub Repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

新增以下兩個 Secret：

| Secret 名稱 | 說明 |
|---|---|
| `VITE_SUPABASE_URL` | 你的 Supabase Project URL，例如 `https://xfxugirjezckmvhbebal.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | 你的 Supabase Anon Key（在 Supabase 後台 Settings → API 取得） |

### 第二步：啟用 GitHub Pages

進入 Repository → **Settings** → **Pages**

- **Source** 選擇：`GitHub Actions`

### 第三步：推送程式碼

```bash
git add .
git commit -m "init"
git push origin main
```

推送後 GitHub Actions 會自動執行建置與部署，約 1~2 分鐘完成。

部署完成後網址為：`https://<你的帳號>.github.io/<repo-name>/`

---

## 💻 本機開發

```bash
# 1. 複製環境變數範本
cp .env.example .env

# 2. 填入你的 Supabase 設定
# 編輯 .env 檔案

# 3. 安裝依賴
npm install

# 4. 啟動開發伺服器
npm run dev
```

---

## 🔧 自訂網域（選填）

若你有自訂網域（例如 `control.yourdomain.com`），在 `vite.config.ts` 中將 `base` 改為 `'/'`：

```ts
// vite.config.ts
return {
  base: '/',   // 改這裡
  ...
}
```

---

## 📁 專案結構

```
├── .github/
│   └── workflows/
│       └── deploy.yml        ← GitHub Actions 自動部署設定
├── src/
│   ├── components/
│   │   ├── LoginScreen.tsx
│   │   └── Dashboard.tsx
│   ├── utils/
│   │   ├── supabaseClient.ts ← Supabase 初始化
│   │   └── mqttClient.ts     ← MQTT 連線工具
│   ├── App.tsx
│   └── main.tsx
├── .env.example              ← 環境變數範本（請勿填入真實值）
└── vite.config.ts            ← Vite 設定（含 GitHub Pages base 路徑）
```
