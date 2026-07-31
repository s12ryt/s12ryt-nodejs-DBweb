# DBWeb 任務紀錄

更新日期：2026-07-31

## 目前狀態

- [x] 讀取原始需求並完成架構、安全、相容性與驗收澄清。
- [x] 將確認結果寫入 `agent/question.md`。
- [x] 建立 TypeScript/pnpm monorepo 與 Vitest/ESLint/TypeScript 測試基線。
- [x] 完成里程碑一：後端身份、直連、唯讀瀏覽、SQL、保活、稽核、管理 UI、部署檔與跨瀏覽器 E2E。
- [x] 完成里程碑二：SSH Tunnel 與 TOFU。
- [ ] 完成里程碑三：M3A 資料 CRUD、M3B 核心 DDL、M3C 進階資料庫物件（M3A 遠端資料庫矩陣驗收中）。
- [ ] 完成里程碑四：Web/DB 帳號與權限分配。
- [ ] 完成里程碑五：CSV/JSON/SQL dump 匯入匯出。
- [ ] 完成里程碑六：多實例、效能、安全與完整回歸。

## 歷史決策

- 2026-07-31：從空工作區啟動；使用者要求完整首版並採分里程碑持續實作。
- 2026-07-31：單機 metadata 採 SQLite；多實例採 PostgreSQL + Redis。
- 2026-07-31：SQL dump 改為純 Node.js 常用 schema/data 相容範圍，不宣稱官方工具完整等價。
- 2026-07-31：正式相容範圍為 PostgreSQL 9.6+、MySQL 5.6+。
- 2026-07-31：完成 SQLite/PostgreSQL metadata 邊界、Argon2id session 身份、AES-256-GCM envelope encryption、PG/MySQL TLS 直連與連線 API。
- 2026-07-31：完成唯讀 schema/table/row 瀏覽、SQL 限制/取消/高風險確認、加密 SQL 稽核及 SQL keepalive 排程與 90 天事件保存。
- 2026-07-31：完成 runtime 組裝、bootstrap admin 驗證與 SQLite 關閉重啟整合測試；正式 Argon2id 參數不因測試逾時而降低。
- 2026-07-31：完成 React/Vite 雙語工作台、連線與使用者對話框、唯讀資料瀏覽、SQL 執行/取消/高風險確認及 production 靜態供應。
- 2026-07-31：修正 Helmet `upgrade-insecure-requests` 導致 WebKit 將 HTTP 靜態資源升級為 HTTPS 的相容性缺陷；保留其餘 CSP 與安全標頭。
- 2026-07-31：Chromium/Firefox/WebKit 核心 E2E 全數通過；Chromium 桌面與手機幾何 smoke 通過。Dockerfile/Compose 已建立，但本機無 Docker，容器 build 未實跑。
- 2026-07-31：完整 M1 回歸為 22 個 Vitest 檔、64 項測試通過，lint、typecheck、production build 通過。
- 2026-07-31：完成 SSH 密碼 tunnel、SHA-256 TOFU 與管理員 pin reset；transport 依 endpoint/username/credential 隔離並跨連線測試、瀏覽、查詢及 keepalive 共用。
- 2026-07-31：完成每 transport 20 channels、30 秒排隊/握手/forward timeout、失敗重連一次、5 分鐘閒置回收與 runtime shutdown；DB host 由 SSH 端解析。
- 2026-07-31：M2 最終回歸為 29 個 Vitest 檔、97 項測試通過；lint、typecheck、production build 與 Chromium/Firefox/WebKit 核心 E2E 通過。Docker 因本機無 executable 仍未實跑。
- 2026-07-31：使用者將 M3 擴為資料庫內進階物件管理，確認拆分 M3A/M3B/M3C；角色權限、匯入匯出及主機/叢集基礎設施仍維持原後續里程碑與排除邊界。
- 2026-07-31：確認建立公開 `s12ryt/s12ryt-nodejs-DBweb`，以 GitHub Actions 真實 PG 9.6/代表性新版與 MySQL 5.6/8.4 LTS 驗證方言能力。
- 2026-07-31：建立並推送 42 個原子初始提交；GitHub Actions quality、三瀏覽器 E2E 與 Docker image build 全綠。Docker build 曾因 `better-sqlite3` 缺 Python/toolchain 失敗，補齊 build stage 原生編譯工具後通過。
- 2026-07-31：M3A 後端完成 tagged value codec、穩定列鍵策略、最多 100 列的交易式新增/更新/刪除/批次 patch、原始值樂觀鎖、PG/MySQL gateway、管理員 HTTP API、90 天加密異動稽核及 runtime 組裝。
- 2026-07-31：M3A 前端完成 capability 驅動的新增、單列編輯、刪除確認、最多 100 列選取與共同 patch；generated、未知型別及無穩定唯一鍵依契約限制。
- 2026-07-31：新增真實資料庫 mutation integration test 與 PostgreSQL 9.6/17、MySQL 5.6/8.4 GitHub Actions 矩陣；本機無資料庫時明確略過，遠端執行結果尚待確認。
