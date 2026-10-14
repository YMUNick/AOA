# AOA 私人 AI 代理

此資料夾提供可選的 Cloudflare Worker，僅供一個私人使用者；前端 GitHub Pages 可獨立部署。代理尚未部署時，網頁可使用個人 API key 模式。**本次沒有替使用者建立 Cloudflare 服務，也沒有執行付費模型測試。**

## 部署

需要可建立 Workers 與 SQLite Durable Objects 的 Cloudflare 帳戶，以及可呼叫 `gpt-6-luna` 的 OpenAI API 帳戶。Worker／儲存服務費與 OpenAI API 費分開計算。

1. 在專案根目錄完成 `npm ci`，再於 `worker` 資料夾執行 `npm ci`。
2. 在 `worker` 執行 `npx wrangler login`，登入自己的 Cloudflare 帳戶。
3. 檢查 `wrangler.toml`。`ALLOWED_ORIGIN` 必須是網頁來源 `https://ymunick.github.io`，不含 `/AOA/` 路徑或結尾斜線。若更改網站網域，更新此值。`ACCOUNT_DAILY_BUDGET_USD` 預設為 `2`，允許大於 0、最多 100 美元；每日以 UTC 重設新請求的預算。
4. 執行 `npm run check`、`npm test`、`npm run test:runtime`、`npm run build`。runtime 測試以本機 workerd／SQLite 執行，所有供應商請求都由測試攔截；build 是本機打包檢查，兩者都不會部署或呼叫付費模型。
5. 執行 `npm run deploy` 建立 Worker 與 Durable Object 綁定。首次建立時尚未設定秘密的付費端點會回覆 503。
6. 依序執行以下命令，並在互動提示輸入值。不要把真正的值寫入命令列、檔案、GitHub Pages 的環境變數或版本庫。

   ```text
   npx wrangler secret put OPENAI_API_KEY
   npx wrangler secret put ACCESS_CODE
   npx wrangler secret put SESSION_SECRET
   ```

   `ACCESS_CODE` 至少 16 個字元，建議用密碼管理器產生 24 個以上隨機字元。`SESSION_SECRET` 至少 32 個字元，建議用密碼管理器產生 48 個以上隨機字元。兩者必須不同，勿含前後空白。
7. 複製部署顯示的 `https://aoa-private-gateway.<你的子網域>.workers.dev`，貼入 AOA 的私人代理網址；輸入 `ACCESS_CODE`，按「測試連線」。這個動作僅驗證憑證，不會呼叫付費模型。會話 60 分鐘後失效；前端遇到 401 時會用仍在記憶體中的存取碼重新驗證一次，沿用原請求 ID 重試，以便持續中的面試不中斷。重新驗證也失敗時顯示錯誤，不會無限重試。
8. 可先在瀏覽器打開 `<代理網址>/capabilities` 確認版本與模型。確認設定後，再由網頁手動產生短回答作為第一次付費驗證。代理不會自動呼叫模型。

更改 `SESSION_SECRET` 會使既有會話失效；只改 `ACCESS_CODE` 不會撤銷已簽發的一小時會話。若需要立即撤銷，兩個秘密一起輪替。重新登入、重啟 Worker、重新部署均不會清除既有帳務狀態。請勿刪除 Durable Object 綁定或變更穩定帳戶識別碼以重設預算。

## HTTP 介面

所有路徑均相對於 Worker 根網址，回應 JSON 且 `Cache-Control: no-store`。禁止任意 provider、模型、URL 或額外欄位。只有未通過會話驗證的 401 可以重新驗證後沿用同一 ID 重送一次；不重送已受理或上游失敗的付費請求。

| 方法與路徑 | 驗證 | JSON 內容／回應 |
|---|---|---|
| `POST /session` | 私人存取碼 | `{ "accessCode": "…" }` → `{ "token": "…", "expiresIn": 3600 }` |
| `GET /capabilities` | 公開，不計模型費 | 模型、單價日期、輸出限制及功能 |
| `POST /answer` | `Authorization: Bearer <token>` | `{ "requestId": "UUID v4", "question": "…", "context": "…", "profile": "…", "style": "concise" }`，style 亦可為 `star` |
| `POST /translate` | 同上 | `{ "requestId": "UUID v4", "text": "…" }` |
| `POST /cancel` | 同上，不計模型費 | `{ "requestId": "UUID v4" }` → 202；中止該請求，或記錄提前抵達的取消訊息，避免遲到請求開始計費 |
| `GET /usage` | 同上 | `{ day, resetTimeZone, spentUsd, reservedUsd, budgetUsd, requests, unconfirmedRequests }` |

生成成功回傳 `{ text, usage?: { inputTokens, outputTokens } }`，整段返回，沒有串流。usage 不明時省略，前端與代理保留預留費用。重複 `requestId` 永遠回覆 409，不重跑模型；包含相同 ID 換內容、跨會話、重啟及跨日。前端每次手動產生動作建立新的 UUID，因此新按一次是另一個可能計費的請求。

主要錯誤：400 請求格式、401 憑證錯誤或過期、402 每日預算、403 權限或來源、409 已受理的 ID、429 限流、502 上游異常、503 尚未設定、504 逾時。錯誤只回傳安全的繁中訊息，不回傳上游原始內容。

## 帳務、隱私與限制

- 問題 1000 字元、上下文 1600、背景 1800、翻譯 1600；JSON 最多 24 KiB。輸出上限：精簡 800、STAR 1000、翻譯 500 tokens，包含計費推理。固定 OpenAI Responses 上游、`reasoning.effort: none`、`store: false`，無工具呼叫或對話歷史。
- 送出前以提示 UTF-8 位元組數＋512 tokens 的訊息包裝餘裕，以及最大輸出原子預留費用。以整數奈美元記帳，使用輸入 $0.10／1M、輸出 $0.50／1M 的保守未快取價格；已回報 output tokens 含推理，不重複加計。
- 供應商成功提供 usage 後結算；失敗、取消、逾時、崩潰或 usage 不明時保留預留。保留金額不會自動退還，因為不能確定沒有計費。每日 UTC 預算只限制該日新請求，前一日的未確認紀錄仍保存在對應日帳本。
- 同時最多 2 項付費請求，每分鐘最多 60 項、每日最多 5000 項。登入每 IP 每分鐘最多 5 次，整個私人代理每分鐘最多 30 次；取消端點每分鐘最多 120 次。限制儲存在 Durable Object，不因重啟或登入重設。
- 持久資料只包括按日彙總、請求 ID 與預留／結算狀態、短期限流計數及加鹽 IP 雜湊。不存放問題、背景、翻譯、回答、provider key、存取碼或會話 token。請求 ID 防重紀錄持續保留，因此儲存用量會隨使用成長。
- CORS 僅限制瀏覽器來源；真正驗證是簽章會話。無 Origin 的命令列也必須提供有效 Bearer。部署沒有多使用者帳號或個別授權管理。
- 40 秒中止代理上游連線，前端 45 秒中止等候。按取消同時發送獨立、已驗證的 `/cancel` 通知（最多等待 5 秒），由相同 Durable Object 中止上游。`enable_request_signal` 與 `request_signal_passthrough` 亦已啟用，但不只依賴瀏覽器斷線事件。若網路已完全斷開，取消通知可能無法送達；中止 HTTP 連線也不保證供應商停止運算／計費。代理預算是本應用防護，並非 OpenAI 帳戶的全域帳單上限。
- 單元測試使用模擬供應商回應與記憶體儲存替身；額外 workerd 測試使用真實本機 SQLite Durable Object，驗證登入、帳務、防重與明確取消上游。這不代表已完成 Cloudflare 生產驗證或真實 API／麥克風長時間演練。

## 官方介面依據（2026-10-14）

- [OpenAI GPT-6 Luna：價格、推理設定](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [OpenAI Responses：輸出與 token 上限](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Google Gemini Interactions API](https://ai.google.dev/api/interactions-api)：前端個人 Gemini 模式使用 `gemini-3.5-flash-lite`，`store: false`，`thinking_level: minimal`。
- [Gemini 思考與含思考的輸出上限](https://ai.google.dev/gemini-api/docs/thinking)：以 `total_output_tokens + total_thought_tokens` 計算輸出用量；缺少完整欄位時保留未知用量。
- [Cloudflare SQLite Durable Object 儲存與交易](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Cloudflare Durable Objects 設定](https://developers.cloudflare.com/durable-objects/get-started/)
- [Cloudflare 取消訊號相容性設定](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-requestsignal-for-incoming-requests)
