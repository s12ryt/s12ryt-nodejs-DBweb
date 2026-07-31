# DBWeb

DBWeb 是以 Node.js、Fastify 與 React 建立的 PostgreSQL/MySQL Web 管理工作台。

## 本機開發

需求：Node.js 22.12 以上與 pnpm 10。

```powershell
pnpm install
$env:DBWEB_MASTER_KEY = node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
$env:DBWEB_ADMIN_PASSWORD = "replace-with-a-password-of-at-least-12-characters"
pnpm dev
```

Web 預設位於 `http://localhost:5173`，API 位於 `http://localhost:3000`。

## Production build

```powershell
pnpm build
$env:NODE_ENV = "production"
pnpm --filter @dbweb/api start
```

production API 會從 `apps/web/dist` 供應管理介面。可用 `DBWEB_WEB_ROOT` 覆寫靜態產物路徑，並以 `DBWEB_METADATA_URL` 改用 PostgreSQL metadata。

## Docker

先依 `.env.example` 建立 `.env`，其中主密鑰必須是 32 bytes 的 base64 值，bootstrap 密碼至少 12 字元：

```powershell
docker compose up --build
```

SQLite metadata 會保存在具名 volume `dbweb-data`。服務預設位於 `http://localhost:3000`。

## 驗證

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm exec playwright install
pnpm test:e2e
```
