# DBWeb 已確認需求契約

更新日期：2026-07-31

## 產品目標

- 建立以 Node.js/TypeScript 開發的 PostgreSQL 與 MySQL Web 管理系統，產品名稱為 DBWeb。
- 支援 Windows、Linux 與 Docker；介面預設繁體中文並可切換英文。
- 同時重視中型負載下的吞吐上限與低資源單機的運行下限。
- 採分里程碑持續交付；每個里程碑完成後直接進入下一階段，直到完整首版完成。

## 使用者與安全

- Web 系統包含管理員與一般使用者；管理員可管理所有連線、帳號與權限。
- 一般使用者只可使用被分配資料庫及被授予的 Web 功能權限。
- 系統亦可建立 PostgreSQL/MySQL 原生帳號，按資料庫分配權限，並產生獨立連線資訊。
- 登入使用 Argon2id 密碼雜湊、HttpOnly/SameSite cookie、安全 session、CSRF 防護與登入限速。
- session 預設閒置 30 分鐘失效，最長 12 小時。
- 資料庫密碼、TLS 憑證、SSH 密碼與稽核 SQL 以環境主密鑰加密後保存。
- 稽核記錄保存完整 SQL，但必須遮蔽 CREATE/ALTER USER 等明確憑證；僅管理員可讀。
- 稽核包含登入、連線、SQL、資料/結構變更、帳號授權與匯入匯出，預設保留 90 天且可調。
- DROP、TRUNCATE、大量刪除等高風險操作顯示摘要並使用一般二次確認。

## 連線能力

- 支援 PostgreSQL 9.6+、MySQL 5.6+；MariaDB 不列入正式支援契約。
- 支援本機與遠端 TCP 連線。
- TLS 支援停用、加密不驗證、CA 驗證、主機名稱驗證及用戶端憑證。
- SSH Tunnel 首版支援密碼驗證，host key 採首次信任後固定（TOFU），變更時拒絕連線。
- 敏感連線資訊不得回傳至一般讀取 API 或寫入明文日誌。

## 管理功能

- 連線：新增、測試、編輯、刪除 PG/MySQL 連線。
- 瀏覽：資料庫、schema、資料表、欄位、索引與分頁資料。
- SQL：多語句編輯器、結果與錯誤呈現、取消查詢、串流結果；預設逾時 30 秒、顯示 1,000 列，管理員可調整上限。
- 資料：以表格新增、修改與刪除資料列。
- 結構：建立、修改與刪除資料庫、schema、資料表及欄位。
- 帳號：建立/修改 PG role、MySQL user，授予或撤銷指定資料庫權限。
- 匯入匯出：CSV、JSON 與 SQL dump。
- 純 Node.js SQL dump/restore 僅承諾常用範圍：表、欄位、資料、常見索引與約束；不宣稱與 pg_dump/mysqldump 完整原生等價。

## 保活與部署

- 同時支援驅動 TCP keepalive 與排程 SQL 健康檢查。
- SQL 保活預設關閉；啟用後預設每 5 分鐘執行 SELECT 1，可設定 1 分鐘至 24 小時，並記錄逾時與成功/失敗。
- 單實例低門檻模式使用內建 SQLite。
- 多實例模式使用外部 PostgreSQL 保存 metadata，Redis 負責 session、佇列與排程協調。
- 目標中型規模：約 100 個連線設定、10 位同時操作者、百萬列資料表透過分頁/串流操作。

## 第一里程碑驗收

- 提供雙語登入、管理員/一般使用者、SQLite/PostgreSQL metadata 邊界及加密連線設定。
- 支援 PG/MySQL 直連與完整 TLS 設定、連線測試、結構/資料唯讀瀏覽。
- 提供 SQL 編輯器、查詢限制與取消、TCP/SQL 保活及加密稽核。
- 提供可運行管理介面、Docker 啟動方式與 Windows/Linux build。
- 自動化驗證涵蓋 Chromium、Firefox、WebKit 的核心流程。
- 所有新增行為依 RED -> GREEN -> REFACTOR 實作；相關測試、型別檢查、lint 與 build 不得有新增錯誤。

## 後續里程碑

1. SSH Tunnel 與 TOFU host key。
2. 資料 CRUD、結構管理與高風險操作確認。
3. Web/原生資料庫帳號、每資料庫功能權限與獨立連線資訊。
4. CSV、JSON、純 Node 常用 SQL dump 匯入匯出。
5. PostgreSQL + Redis 多實例協調、效能、安全與完整回歸驗證。

## 第二里程碑 SSH 契約

- SSH tunnel 使用密碼驗證；資料庫 host/port 由 SSH 主機端解析並建立 TCP forwarding channel。
- TOFU pin 以正規化 SSH host + port 為 endpoint 範圍共用，保存 SHA-256 host key 指紋；首次連線以原子方式固定，後續 key 不同時拒絕。
- 管理員可明確重設 endpoint pin，並記錄操作者、endpoint 與時間；重設不立即關閉既有 transport，舊 transport 最多可沿用至 5 分鐘閒置回收，下一次握手重新 TOFU。
- transport pool 以 endpoint、SSH username 與 HMAC credential fingerprint 隔離；fingerprint 只存在記憶體，不保存或記錄 SSH 密碼。相同實際密碼才可共享 transport。
- transport 跨瀏覽、查詢、連線測試與 keepalive 操作共用；無活動 5 分鐘後關閉，runtime shutdown 等待/關閉全部 transport。
- 每個 transport 最多同時開啟 20 個 forwarding channels；超額請求最多排隊 30 秒，逾時回安全的 tunnel busy 錯誤。
- SSH 握手與 forwarding channel 預設各 30 秒。transport 斷線或開 channel 失敗時淘汰並自動重連一次；第二次失敗才向呼叫端回安全錯誤。
- SSH 密碼與設定沿用既有 envelope encryption 邊界；公開 API、稽核與錯誤不得包含密碼、host key 原文或 driver/SSH 底層訊息。

## 第三里程碑資料與物件管理契約

- 因功能範圍擴張，M3 依序拆為 M3A 資料 CRUD、M3B 核心 DDL、M3C 進階資料庫物件；每段完成 RED/GREEN、回歸與驗收後直接進下一段。
- M4 細粒度權限完成前，M3 所有資料寫入與結構管理僅管理員可用；一般使用者維持 M1 的唯讀瀏覽與 SQL 權限現況。

### M3A 資料 CRUD

- 修改與刪除只允許具有主鍵或可用非空唯一鍵的資料列；無穩定唯一鍵的資料表維持唯讀且不可刪除。
- 更新使用唯一鍵加原始值樂觀鎖；受影響列數不是一列時回 409 衝突，不得靜默覆蓋並行變更。
- 支援單列新增、修改、刪除及批次選取；批次同時支援每列各自新值與同一 patch 套用選取列，單次最多 100 列。
- 批次操作在單一交易中全成或全敗；任何列衝突或錯誤須整批回滾並回報可定位的失敗項目。
- 所有刪除均顯示摘要並二次確認。新增成功後 API 回 affected rows 與可取得的 insert id，UI 重新抓取目前頁面，不猜測 MySQL default/generated 後的完整資料列。
- JSON wire format 使用型別標記值保存 bigint、decimal、date、time、datetime、timestamptz、binary、json 與 array；uuid/enum 使用 string。NULL、DEFAULT 與具體值三態明確區分；未知 driver 型別維持唯讀並提示。
- generated/identity/auto increment 欄位預設不可手動寫入；新增可省略或使用 DEFAULT，修改可明確 SET DEFAULT；空字串不得自動轉為 NULL。

### M3B 核心 DDL

- 管理 database/schema/table/column/index/constraint，並依實際 PostgreSQL/MySQL server version 回傳 capability matrix；未知版本採最低支援版本能力。
- 圖形 API 使用版本化、可測試的方言白名單。未納入的 vendor-specific clause 由既有 SQL 編輯器處理，不接受任意 extra SQL 混入結構 API。
- 欄位型別採方言白名單；default 分為 NULL、literal 與已知安全函式。支援方言可提供的 rename、owner、type、nullable、default、identity/auto increment、engine、charset、collation 等選項，不模擬資料庫本身不存在的能力。
- 索引支援 PG BTREE/HASH/GIN/GiST/BRIN、expression、partial，以及 MySQL BTREE/HASH/FULLTEXT、欄位 prefix length；method、欄位、排序與 prefix 結構化。PG expression/predicate 使用受限片段，拒絕分號與註解並強制二次確認及完整稽核。SPATIAL 暫不納入此已確認集合。
- 約束支援 PK、UNIQUE、FK、CHECK 的建立與刪除；修改採刪除後重建並二次確認，FK 支援常見 ON DELETE/UPDATE 動作。MySQL 5.6 拒絕建立不會強制執行的 CHECK 並明確提示，支援版本才開放。
- PostgreSQL 可交易 DDL 盡量使用交易；CREATE/DROP DATABASE 及 MySQL DDL 依真實能力標示非原子並逐步稽核，不宣稱可回滾。
- DROP database/schema/table/column/index/constraint、欄位型別或 nullable 收緊、PK/FK/CHECK、進階或可能重負載索引均需摘要與二次確認；單純 create 與 rename 不要求確認。

### M3C 進階物件

- 圖形管理範圍限資料庫內可管理物件。PostgreSQL 包含 view、materialized view、sequence、type/domain/enum、function/procedure、trigger、partition、extension；MySQL 包含 view、procedure/function、trigger、event、partition。
- role/user/grant 保留 M4；匯入匯出保留 M5；tablespace、FDW/user mapping、replication/publication/subscription、server configuration 等主機或叢集基礎設施不納入首版圖形管理。
- 名稱與可列舉選項必須結構化。view/function/procedure/trigger 等 query/body 允許管理員提供方言原文與必要分號；強制二次確認、加密完整稽核與憑證遮蔽，不宣稱以字串掃描即可安全解析任意程序本文。

### 稽核、整合與 CI

- 圖形化資料/結構變更稽核保存 actor、connection、物件識別、動作、受影響列數、成功/失敗與參數化 SQL template；不保存資料列 before/after 值。程式碼型物件原文依既有加密 SQL 稽核與遮蔽規則保存。
- 真實方言整合測試由 GitHub Actions service containers 執行，核心矩陣固定 PostgreSQL 9.6 與代表性穩定新版、MySQL 5.6 與 8.4 LTS；版本特定功能依 capability 測試。
- 建立公開 repository `s12ryt/s12ryt-nodejs-DBweb` 並推送原子 commit。不得提交環境主密鑰、真實密碼、SQLite runtime資料或測試產物。
