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

## 第四里程碑帳號與權限契約

### Web 使用者與每連線能力

- 一般使用者按 connection 分配固定六項能力：結構瀏覽、資料讀取、唯讀 SQL、資料寫入、結構 DDL、原生帳號權限管理。管理員永遠具有全部能力，且只有管理員可配置其他 Web 使用者的 connection 能力。
- 未分配的 connection 對一般使用者完全不可見。新分配預設授予結構瀏覽、資料讀取與唯讀 SQL；M4 migration 對既有非管理員不自動分配任何既有 connection。
- 權限相依自動補齊：資料讀取包含結構瀏覽；資料寫入包含結構瀏覽與資料讀取；結構 DDL 包含結構瀏覽；原生帳號權限管理維持獨立。
- 權限不固化於 session；每個受保護請求即時讀取 metadata，撤銷後下一個請求立即生效。唯讀 SQL 先拒絕多語句與明顯寫入/DDL，再由 PostgreSQL/MySQL 唯讀交易提供第二層限制。
- Web 使用者支援啟用/停用、admin/user 升降級、管理員重設密碼與永久刪除。停用、角色變更、密碼重設與刪除立即撤銷該使用者全部 session；不得停用、降級或刪除最後一位可用管理員。
- 管理員可產生 20 字元臨時密碼或手動輸入至少 12 字元密碼；臨時密碼只在當次回應顯示，使用者下次登入必須先更改密碼才能使用其他功能。
- 永久刪除 Web 使用者時刪除 session 與 connection 權限，保留匿名化安全稽核中的不可登入 user ID，不保存可登入資料且不可復原。

### 原生 PostgreSQL/MySQL 帳號

- 原生帳號與 Web 使用者完全獨立，不建立所有權關聯。列表即時讀取資料庫內全部帳號與實際授權；外部帳號亦可由具權限操作者管理，但在輪替密碼納管前不得查看連線詳情或執行背景憑證驗證。
- PostgreSQL 以 role name 識別；MySQL 以 `user@host` 識別。MySQL host 預設 `%`，允許 IP、hostname 與 `%`/`_` pattern，拒絕 NUL、控制字元及語法注入，UI 明確警告 `%` 的廣泛來源範圍。
- 可配置一般帳號屬性：登入/停用、密碼到期、連線上限及 MySQL host pattern，依 server version capability 開放。首版不提供 PostgreSQL CREATEDB/CREATEROLE/BYPASSRLS/SUPERUSER，亦不提供 MySQL CREATE USER/GRANT OPTION/SUPER/SYSTEM_USER/FILE 等管理或主機級屬性。
- 永遠保護目前 DBWeb connection 使用的帳號、PostgreSQL 預定義/超級使用者及 MySQL 系統帳號；這些帳號只可檢視，不可由 DBWeb 修改、輪替、停用或刪除。
- 密碼預設由系統產生 32 字元高強度值，也允許管理員輸入至少 16 字元；以環境主密鑰和帳號用途綁定加密保存。管理員每次重看保存密碼前必須重新輸入本人 Web 密碼，成功後只回傳一次並寫安全稽核。
- 具「原生帳號權限管理」能力的一般使用者可建立、納管輪替、停用、刪除、復原及管理 grants，但完全不可看到新密碼或已保存密碼；只有管理員可在操作當次及重新驗證後查看密碼。
- 受管帳號可設定每 1 小時至 7 天的背景登入驗證週期，預設 6 小時；每個 connection 最多 5 個並行。失敗 30 分鐘後只重試一次，再失敗即標記 credential stale，直到下一正常週期、手動測試或輪替成功。
- 每個受管帳號指定一個驗證 database，預設為 connection 原 database。SSH connection 的連線資訊顯示 DB host/port/database/user/password及SSH host/port/username，但永不顯示DBWeb保存的SSH密碼，並提示SSH憑證需另行取得。

### 原生授權、跨資料庫與生命週期

- 原生授權採白名單，涵蓋連線/使用（PostgreSQL CONNECT、schema USAGE）、資料操作（SELECT、INSERT、UPDATE、DELETE）及依方言/層級合法的結構操作（CREATE、ALTER、DROP、INDEX、REFERENCES）；不提供 EXECUTE 或 WITH GRANT OPTION。
- 管理員手動輸入同一 server 的目標 database 名稱；PostgreSQL以既有connection憑證、TLS與SSH建立目標database暫時連線，MySQL以同server連線及完整限定名稱操作。排除且禁止操作PostgreSQL `template0`/`template1`與MySQL `mysql`/`information_schema`/`performance_schema`/`sys`。
- 支援database、schema與table層授予/撤銷。列表與詳情每次以資料庫實際帳號及 grants 為準；metadata只保存加密憑證、驗證排程、管理狀態與刪除快照，不把預期 grants 當成第二真相。
- 建立、停用、刪除、復原與批次 REVOKE 均需摘要與二次確認。若帳號仍擁有物件或存在資料庫拒絕的依賴，安全失敗並回摘要；不得自動 `REASSIGN OWNED`、`DROP OWNED`、級聯或強制刪除。
- PostgreSQL可交易的帳號與授權操作盡量整體回滾；MySQL DCL/帳號操作依真實非原子語意逐步執行、失敗即停、逐步稽核並回 partial failure，之後重新讀取實際狀態，不做不可靠的應用層補償。
- 刪除受管帳號後保留停用紀錄、加密密碼與一般帳號屬性 14 天，二次確認後可用相同帳號與密碼重建，但不恢復 grants；外部未納管帳號保留非敏感屬性 14 天，復原時必須產生或輸入新密碼。名稱已被占用或依賴不成立時安全失敗。14 天後清除可解密密碼與復原資料，只保留安全稽核。

### 安全、稽核與驗收

- M4安全稽核記錄登入重新驗證、密碼查看、Web權限變更、帳號建立/納管/輪替/停用/刪除/復原、GRANT/REVOKE、背景驗證及成功/失敗狀態，保存 365 天。密碼永不寫入稽核、錯誤或一般API；SQL template依既有AES-GCM與憑證遮蔽邊界加密保存。
- 敏感帳號操作維持登入、CSRF、即時能力檢查、限速與安全錯誤；driver訊息、密碼hash、加密密文及DB/SSH秘密不得洩漏。管理員密碼重新驗證不得建立新的長效提升權限，只授權單次密碼查看。
- 完成條件沿用 PostgreSQL 9.6/17、MySQL 5.6/8.4 真實整合矩陣；Chromium、Firefox、WebKit E2E涵蓋Web授權即時生效，以及原生帳號建立、納管輪替、查看、停用、刪除/復原與grant/revoke核心流程。Docker build、單元/整合測試、lint、strict typecheck及production build必須全綠。
