# DBWeb 操作紀錄

## 2026-07-31

- 讀取 `需求.md`；工作區原先只有此檔案。
- 確認工作區不是 Git repository，無既有程式碼、依賴、測試或專案規範。
- 完成多輪需求澄清，結果寫入 `agent/question.md`。
- 建立 `agent/deep_todos.md`、`agent/項目表.md` 與本操作紀錄。
- 建立 TypeScript/pnpm monorepo、Fastify API、Kysely metadata 與 Vitest/ESLint/TypeScript 工具鏈。
- 依 RED -> GREEN 完成身份/session/CSRF/限速、加密連線設定、PG/MySQL TLS connector、唯讀資料瀏覽與 HTTP API。
- 依 RED -> GREEN 完成 SQL 多語句、結果上限、逾時、取消、高風險確認、加密稽核及 PostgreSQL/MySQL gateway。
- 依 RED -> GREEN 完成 SQLite/PostgreSQL metadata repositories、runtime 組裝、bootstrap admin 衝突檢查及 SQLite 重啟整合。
- 依 RED -> GREEN 完成 SQL keepalive 排程、同連線防重疊、停止等待 in-flight tick 與 90 天事件保存。
- 已驗證 runtime/keepalive targeted regression 共 4 files、8 tests，且 API typecheck 通過；Docker 在本機不可用，尚未驗證容器執行。
- 依 RED -> GREEN 完成 React/Vite 雙語工作台，涵蓋登入/session restore、連線選取與唯讀瀏覽、SQL 高風險確認、取消及管理對話框。
- 依 RED -> GREEN 完成 Fastify production 靜態供應與 SPA fallback；修正 Helmet CSP 在 WebKit 將 HTTP assets 升級為 HTTPS 的缺陷。
- 建立 Dockerfile、Compose、環境範例與操作文件；本機沒有 Docker executable，容器 build/runtime 尚未完整驗證。
- 修正 Web `tsc -b` 將生成檔寫入 `src` 的問題，改由 `tsc --noEmit` 驗型、Vite 單獨輸出 `dist`；清除本輪生成物。
- M1 最終驗證：Vitest 22 files/64 tests、ESLint、全 workspace typecheck、production build 全通過；Playwright Chromium/Firefox/WebKit 核心流程通過，Chromium 1440x900 與 390x844 無水平溢位及主要區塊重疊。
- 依 RED -> GREEN 完成 M2 SSH：密碼驗證、SHA-256 TOFU 原子 pin、管理員 reset audit、共享 transport pool、channel 限流/排隊/逾時、重連與閒置回收。
- 將 SSH forwarding socket 注入 PG/MySQL 連線測試、唯讀瀏覽、SQL query 與 keepalive 共用 gateway；runtime 關閉時依序停止 scheduler、關閉 tunnel pool、銷毀 metadata。
- 完成雙語 SSH 連線 UI 與 TOFU reset 二次確認；公開畫面/API 不回傳 SSH 密碼，DB host 保持由 SSH 主機端解析。
- M2 最終驗證：Vitest 29 files/97 tests、ESLint、全 workspace typecheck、production build 全通過；Playwright Chromium/Firefox/WebKit 核心流程通過。首次並行品質命令造成 Argon2 測試資源逾時與 Playwright目錄競爭，序列重跑均通過。
