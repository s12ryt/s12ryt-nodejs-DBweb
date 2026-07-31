# DBWeb 任務紀錄

更新日期：2026-07-31

## 目前狀態

- [x] 讀取原始需求並完成架構、安全、相容性與驗收澄清。
- [x] 將確認結果寫入 `agent/question.md`。
- [x] 建立 TypeScript/pnpm monorepo 與 Vitest/ESLint/TypeScript 測試基線。
- [x] 完成里程碑一：後端身份、直連、唯讀瀏覽、SQL、保活、稽核、管理 UI、部署檔與跨瀏覽器 E2E。
- [x] 完成里程碑二：SSH Tunnel 與 TOFU。
- [x] 完成里程碑三：M3A 資料 CRUD、M3B 核心 DDL、M3C 進階資料庫物件。
- [x] 完成里程碑四 A：Web 使用者生命週期與每 connection 即時能力授權。
- [x] 完成里程碑四 B：原生 DB 帳號、加密憑證、背景驗證與生命週期。
- [x] 完成里程碑四 C：跨 database 權限與完整驗收。
- [x] 完成里程碑五 A：持久化 job、分段加密暫存、preview 與安全下載基礎。
- [ ] 完成里程碑五 B：CSV/JSON 串流匯入匯出、映射、衝突與續傳。
- [ ] 完成里程碑五 C：純 Node SQL dump/restore、進階物件、UI與完整驗收。
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
- 2026-07-31：M3A 首次遠端矩陣精準捕捉 PostgreSQL `name[]` array literal 與 MySQL 8.4 information_schema 欄名大小寫差異；以 PostgreSQL `text[]` 兼容解析及 MySQL 固定 alias 修復。
- 2026-07-31：M3A GitHub Actions run `30597219150` 全綠；PostgreSQL 9.6/17、MySQL 5.6/8.4 真實 mutation、quality、Docker image 與三瀏覽器均通過。M3A 完成並直接進入 M3B。
- 2026-07-31：M3B 完成依伺服器版本動態偵測的核心 DDL capabilities、結構化型別/default/storage 白名單，以及 database/schema/table/column/index/PK/UNIQUE/FK/CHECK 方言 SQL builder；高風險與重負載操作依契約要求二次確認。
- 2026-07-31：M3B 完成 PG/MySQL DDL gateway、管理員限定 service/HTTP API、90 天 AES-GCM 加密 SQL template 稽核與 runtime 組裝；PG 可交易 DDL 使用交易，database DDL 與 MySQL DDL 依真實能力標記非原子。
- 2026-07-31：M3B 前端完成管理員結構工作台與 16 項核心 DDL 命令，依 live capabilities 顯示/停用功能；本機最終驗證為 45 個 Vitest 檔通過、2 個整合檔略過，157 tests 通過、4 個真實 DB cases 略過，lint、typecheck、build 與三瀏覽器核心 E2E 全綠。
- 2026-07-31：M3B 首次遠端矩陣 run `30599472205` 在 MySQL 5.6/8.4 精準捕捉 `AUTO_INCREMENT` 欄位未同時建立索引或主鍵的合法性缺陷；先以 builder 測試建立 RED，再要求 MySQL identity 欄位必須納入 create-table primary key。
- 2026-07-31：M3B GitHub Actions run `30599742558` 全綠；PostgreSQL 9.6/17、MySQL 5.6/8.4 真實 mutation 與 DDL、quality、Docker image 及三瀏覽器均通過。M3B 完成並直接進入 M3C。
- 2026-07-31：M3C 完成版本化進階物件 capability 與方言 builder；涵蓋 PostgreSQL view/materialized view/sequence/enum/domain/function/procedure/trigger/partition/extension，以及 MySQL view/function/procedure/trigger/event/partition。原文 query/body 需管理員確認並沿用 AES-GCM SQL template 稽核。
- 2026-07-31：M3C 前端結構工作台擴為 36 項核心與進階 DDL 操作，依真實版本停用不支援項目；PostgreSQL 9.6 procedure 與 partition 邊界已有 UI 回歸測試。
- 2026-07-31：M3C 本機驗證為 47 個 Vitest 檔通過、2 個整合檔略過，173 tests 通過、6 個無本機 DB 的 cases 略過；lint、typecheck、production build 與三瀏覽器核心 E2E 全綠。四版本進階物件矩陣待 GitHub Actions 實跑。
- 2026-07-31：M3C GitHub Actions run `30601615401` 的 quality、container、browser、PostgreSQL 9.6/17 與 MySQL 5.6 均通過；MySQL 8.4 真實驗收發現 binary logging 下 stored function 需要明確 routine characteristic，依官方文件新增結構化 `deterministic`/`dataAccess` 白名單、跨版本安全驗證、前端欄位與 integration fixture。
- 2026-07-31：第二次 run `30602275693` 仍由 MySQL 8.4 拒絕函式建立；加入僅整合測試使用的安全診斷後，run `30602542105` 精確取得 `ER_BINLOG_CREATE_ROUTINE_NEED_SUPER`，證明即使 SQL 含 `DETERMINISTIC NO SQL`，預設 binary logging 政策仍要求全域管理權限。
- 2026-07-31：MySQL 矩陣由 root 明確設定測試專用 `log_bin_trust_function_creators=1`，再以非管理員 `dbweb` 帳號執行功能驗收；產品 gateway 仍只回安全 `DDL_FAILED`。最終 GitHub Actions run `30602738639` 的 quality、container、browser、PostgreSQL 9.6/17、MySQL 5.6/8.4 全綠，M3C 與里程碑三完成。
- 2026-07-31：Vitest worker 上限設為 2，避免多個正式 Argon2 HTTP 測試同時執行造成資源競爭逾時；未降低密碼雜湊參數或測試斷言。
- 2026-07-31：M4 契約細分為 M4A Web 使用者與每 connection 能力、M4B 原生帳號與憑證生命週期、M4C 跨 database grant/revoke 與完整 UI/矩陣驗收。
- 2026-07-31：M4A 完成六項 Web capability、未授權 connection 隱藏與逐請求 metadata 驗權；一般使用者 SQL 同時經語句分類器及 PostgreSQL/MySQL 唯讀交易防護，資料異動與 DDL 在 HTTP/service 兩層授權。
- 2026-07-31：M4A 完成 Web 使用者停啟、角色升降、臨時密碼、強制改密碼、重設與永久刪除；所有敏感狀態變更撤銷 sessions，最後可用管理員由 metadata transaction lock 保護。
- 2026-07-31：M4A 安全事件以 AES-GCM 保存 365 天且不記錄密碼；前端完成使用者生命週期與六能力矩陣，並修正共用 dialog 重複 heading ID。完整本機驗證為 52 個 Vitest 檔、215 tests 通過、6 個無本機 DB cases 略過，lint、strict typecheck、production build 與三瀏覽器核心 E2E 全綠。
- 2026-07-31：M4B 完成 PostgreSQL role 與 MySQL user@host 的實際帳號列舉、保護規則、受限建立、納管輪替、停啟、手動驗證、刪除與 14 天無 grants 復原；連線帳號與系統帳號維持只讀保護。
- 2026-07-31：原生帳號密碼預設生成 32 字元並以 account ID 綁定 AES-GCM 密文保存；管理員須用本人 Web 密碼單次重驗才可查看，一般 account manager 永不取得明文。所有生命週期及驗證事件納入 365 天安全稽核且不保存密碼或 driver 錯誤。
- 2026-07-31：背景憑證驗證依 connection 最多五筆並行，預設每六小時；第一次失敗 30 分鐘後重試一次，第二次標記 credential-stale。scheduler 防重疊並在 runtime 關閉時等待 in-flight tick。
- 2026-07-31：M4B 前端完成原生帳號建立、納管、輪替、立即驗證、停啟、刪除復原及管理員重驗查看密碼；受保護帳號不顯示危險操作，一次性密碼只存在 React 暫時狀態。前端行為 20/20、M4B targeted 後端 46/46 通過。
- 2026-07-31：M4B 遠端矩陣依序抓到 MySQL 5.6 不支援 `DROP USER IF EXISTS`、帳號名稱上限 16 字元、`CREATE USER` 不接受新版資源限制語法，以及設定 `MAX_USER_CONNECTIONS` 需由具委派能力的 DBWeb 管理連線執行 `GRANT USAGE`。診斷只存在 integration test，正式 gateway 始終遮蔽 driver 細節。
- 2026-07-31：MySQL 5.6 改用 `CREATE USER` 後 `GRANT USAGE ... WITH MAX_USER_CONNECTIONS`；CI 的受保護 DBWeb 管理連線明確取得 `CREATE USER ... WITH GRANT OPTION`，受管帳號本身仍不取得管理權限。GitHub Actions run `30616451344` 的 quality、container、browser、PostgreSQL 9.6/17、MySQL 5.6/8.4 全綠，M4B 完成並進入 M4C。
- 2026-07-31：M4C 完成結構化跨 database grant/revoke planner、PostgreSQL direct ACL 與 MySQL grant table 實際權限讀取、受保護帳號與系統 database 防護、即時 `account-manage` 授權及安全 HTTP/runtime 組裝。
- 2026-07-31：PostgreSQL grant batch 使用單一交易並於失敗全數 rollback；MySQL 逐步執行、首錯停止並回安全 `appliedCount/failedIndex`，每一步寫入 365 天 AES-GCM 安全稽核，SQL template 不以明文索引保存。
- 2026-07-31：M4C 前端完成實際權限讀取、方言/層級白名單編輯、GRANT 與 REVOKE 二次確認；本機驗證為 62 個 Vitest 檔、264 tests 通過、10 個無本機 DB cases略過，lint、strict typecheck、production build及三瀏覽器授權E2E全綠。
- 2026-07-31：M4C 首次遠端 run `30619429165` 由 MySQL 5.6/8.4 精準發現管理連線只能讀 `mysql.user`、無法讀取實際 database/table grants；CI 只補 `mysql.db` 與 `mysql.tables_priv` 的 `SELECT`，不擴張整個 system schema。最終 run `30619840307` 的 quality、container、browser、PostgreSQL 9.6/17、MySQL 5.6/8.4 全綠，里程碑四完成。
- 2026-07-31：M5 完成契約澄清並拆為 M5A job/加密檔案基礎、M5B CSV/JSON、M5C SQL dump/完整驗收；支援10GB分段上傳、強制preview、批次重新掃描續傳、tar/gzip封裝、精確與友善匯出模式及同引擎進階物件restore。
- 2026-07-31：M5A 完成 SQLite/PostgreSQL 持久化 transfer job、owner/connection 各兩筆 active 配額與 optimistic CAS；job 狀態、進度、取消、失敗重啟及 90 天 metadata 契約均由 domain/repository 測試保護。
- 2026-07-31：來源與輸出使用不同 AAD namespace 的 AES-GCM 分段暫存；8 MiB chunks、10 GiB 上限、段與整檔 SHA-256、冪等續傳、symlink/path traversal/tamper 防護及 24 小時/7 天/90 天清理政策已完成。
- 2026-07-31：完成受信任 inspector 驅動的 30 分鐘 preview token 核心、安全串流下載、90 天加密 transfer audit、逐請求能力驗證與 runtime cleanup scheduler；CSV/JSON 與 SQL 的實際 inspector 分別留在 M5B/M5C 接入。
- 2026-07-31：雙語 transfer 工作台可建立、列出、取消、下載及以增量 SHA-256 分段上傳；M5A 本機驗證為 74 個 Vitest 檔通過、3 個 integration 檔略過，300 tests 通過、10 cases 略過，lint、strict typecheck、production build 與三瀏覽器既有 E2E 全綠。
- 2026-07-31：M5A 以 15 筆原子提交推送；GitHub Actions run `30627658026` 的 quality、Docker image、browser、PostgreSQL 9.6/17 與 MySQL 5.6/8.4 全綠，M5A 完成並直接進入 M5B。
- 2026-07-31：M5B 第一階段完成精確 tagged JSON/CSV 串流格式、友善 CSV 與公式注入防護、結構化 AND-only filter、欄位映射、衝突/交易/續傳策略及受限 ustar/gzip 封裝；所有來源值與 filter 均維持型別驗證及參數化邊界。
- 2026-07-31：完成 PostgreSQL repeatable read-only cursor 與 MySQL consistent read-only snapshot 串流 gateway、固定分段 output writer及友善 CSV export orchestration；中途取消、提早停止、driver/audit失敗皆清除partial output並安全關閉交易與SSH channel。
- 2026-07-31：preview inspector產生的不可變執行plan以job綁定AES-GCM保存30分鐘，token與source/mapping/strategy/target/capability/schema fingerprint共同驗證；公開preview回應只含token、估算與遮蔽issues。M5B基礎 targeted為13 files/47 tests，完整回歸為84 files、342 tests通過；實際CSV/JSON executor、import與四版本roundtrip仍在進行。
- 2026-07-31：M5B 完成 friendly CSV preview/execute/cancel 的 HTTP/runtime/UI 整合，以及精確 JSON 多表一致性快照匯出、加密 staging tar/gzip package、server-derived preview、串流 package reader與匯入 orchestration。
- 2026-07-31：精確 JSON 匯入已完成 PostgreSQL/MySQL 方言 gateway；atomic 失敗全數 rollback，batch 只保留已提交進度，skip/update/replace、generated identity與 PostgreSQL sequence同步皆由測試保護。preview會重驗來源manifest、target schema、能力與checksum。
- 2026-07-31：transfer handler依伺服器端job direction/format分派friendly CSV export、exact JSON export/import；不支援組合不會fallback，但仍可取消以釋放active配額。source/output/json-stage使用不同AAD namespace並納入retention cleanup。
- 2026-07-31：本切片完整本機驗證為95個Vitest檔通過、3個integration檔略過，377 tests通過、10個無本機DB cases略過；lint、strict typecheck、production build及Playwright 7 passed/2 responsive skipped全綠。精確CSV executor與四版本roundtrip仍待完成。
