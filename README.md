# AOA · 面試即時翻譯助手

英文即時字幕、繁體中文翻譯，以及由你圈選後才產生的 AI 回答。深藍黑、青藍與電光紫工作台，支援桌面與手機排版。

**網站：[https://ymunick.github.io/AOA/](https://ymunick.github.io/AOA/)**

## 開始使用

1. 用新版桌面 Chrome 開啟網站，也可以先按「先試用示範」。示範不收音、不呼叫付費服務。
2. 選「本機翻譯」，按「準備翻譯」下載所需模型。若瀏覽器不支援，仍可使用英文字幕，或明確選擇會計費的雲端翻譯。
3. AI 回答可選 OpenAI 或 Gemini，填入自己的 API 金鑰；或者連到自己的安全代理。沒有金鑰仍可使用已就緒的本機翻譯與字幕。
4. 按「開始聆聽」並允許麥克風。網站使用系統預設麥克風，不擷取 Teams／Zoom 系統音訊。
5. 反白字幕或按「選取整段」，再按「產生回答」。可取得英文建議與中文重點，也能選用 STAR 架構。
6. 訪談結束後按「匯出」，下載逐字稿與最近一次回答；開始新訪談或重新整理會清除內容。

手機或不支援語音辨識的瀏覽器，可按「貼上英文」手動加入文字。單一麥克風也會收進自己的聲音，網站不會假裝知道說話者身分。

## 費用與資料

估算牌價更新於 **2026-10-14**。每小時 20 次回答，每次約 1,500 輸入、500 輸出 tokens，含 20% 餘裕：

| 模型 | 本機翻譯＋20 次回答 | 雲端文字翻譯＋20 次回答 |
|---|---:|---:|
| OpenAI `gpt-6-luna` | 約 US$0.01 | 約 US$0.03–0.05 |
| Gemini `gemini-3.5-flash-lite` | 約 US$0.04 | 約 US$0.12–0.19 |

不含另外購買的語音 API、代理服務、稅或匯差。模型可用性與牌價以供應商為準；這些是工程估算，不是實測帳單。API 計費與 ChatGPT／Codex 訂閱分開。

- 本機翻譯沒有額外翻譯 API 費；瀏覽器語音辨識可能透過瀏覽器廠商的雲端服務處理，因此不宣稱全程離線。
- 雲端翻譯只傳送新完成片段；回答只傳圈選內容、有限前文及你提供的背景，不反覆傳整場逐字稿。
- 金鑰、逐字稿與背景預設只留在分頁記憶體；不寫入 localStorage、repo 或網站伺服器。不錄製或儲存音訊。
- 個人金鑰模式會把金鑰交給目前頁面的程式，因此只供個人自用；記憶體儲存不等於秘密隔離。正式使用建議部署自己的安全代理。
- 費用欄包含已知用量及進行中／待確認的預留費用；取消或失敗仍可能計費。達預算後停止新的付費請求，不影響本機字幕。
- 前端預算是本次分頁的防護，重新整理可重置，不是供應商帳戶的硬上限。私人代理另有持久化每日預算，跨 session 保留。
- 模型回覆一次完成後顯示，等待時有明確狀態與取消按鈕。未提供真實經歷時使用可替換框架，不應把範例直接當作自身經驗。

## 本機開發

需要 Node.js 24。

```sh
npm ci
npm run dev
```

開啟終端顯示的 `/AOA/` 網址。

```sh
npm test
npm run check
npm run build
npm run preview
```

單元與整合測試涵蓋字幕去重、停止／重連、翻譯能力檢查、demo 隔離、過期回應、API 錯誤、預算預留與代理驗證。瀏覽器驗證使用模擬語音／翻譯／API，不會產生真實費用。仍需在使用者實際麥克風、網路與付費帳戶環境驗證；**尚未完成真實 60 分鐘連續面試測試**。

## GitHub Pages

`.github/workflows/deploy.yml` 在 `main` 更新時執行測試、建置並部署 `dist`。

- repo Settings → Pages → Source 選 **GitHub Actions**。
- 專案 base path 固定為 `/AOA/`，使用同頁狀態切換，不需要伺服器路由。
- GitHub Pages 只部署前端，不能執行 API 代理或存放秘密。**不要把 API key 寫進 `VITE_*` 環境變數。**

## 安全代理（選用）

`worker/` 提供 Cloudflare Worker＋SQLite Durable Object，支援 OpenAI。包含短效會話驗證、登入限流、固定上游、文字／輸出上限、request ID 去重與原子每日預算。provider key 放在 Worker secrets。

請依 [worker/README.md](worker/README.md) 設定自己的 Cloudflare 帳戶與秘密並部署。前端上線不代表代理已上線。未設定代理時，可用個人金鑰模式。

## 設計資料

- [完整設計與估算假設](docs/design/2026-10-14-aoa-design.md)
- [首頁設計](docs/design/home.svg)
- [工作台設計](docs/design/session.svg)
- [實作紀錄](docs/implementation-plan.md)

參考：[Chrome 本機翻譯](https://developer.chrome.com/docs/ai/translator-api)、[Web Speech](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)、[OpenAI 模型價格](https://developers.openai.com/api/docs/models/gpt-6-luna)、[Gemini 價格](https://ai.google.dev/gemini-api/docs/pricing)。
