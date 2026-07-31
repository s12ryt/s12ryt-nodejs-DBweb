import { expect, test } from '@playwright/test'

test('loads actual native grants and confirms revocation', async ({ page }) => {
  const commands: unknown[] = []
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    if (url.pathname === '/api/auth/me') {
      await route.fulfill({ json: { user: { id: 'admin-1', username: 'admin', role: 'admin', enabled: true, passwordChangeRequired: false }, csrfToken: 'csrf-token' } })
      return
    }
    if (url.pathname === '/api/connections') {
      await route.fulfill({ json: [{
        id: 'connection-1', name: 'Integration PostgreSQL', engine: 'postgres', host: 'db.internal', port: 5432,
        database: 'inventory', username: 'dbweb', tls: { mode: 'disable', hasCa: false, hasClientCertificate: false },
        keepAlive: { enabled: false, intervalMs: 300000 }, createdBy: 'admin-1', createdAt: new Date().toISOString(),
      }] })
      return
    }
    if (url.pathname.endsWith('/schemas')) {
      await route.fulfill({ json: [] })
      return
    }
    if (url.pathname.endsWith('/accounts') && method === 'GET') {
      await route.fulfill({ json: [{
        identity: { engine: 'postgres', username: 'reporter' }, canLogin: true, passwordExpired: false,
        connectionLimit: -1, systemAccount: false, managed: true, managedAccountId: 'native-1', protected: false,
        managedStatus: 'active',
      }] })
      return
    }
    if (url.pathname.endsWith('/accounts/grants') && method === 'GET') {
      await route.fulfill({ json: [{ scope: 'database', database: 'analytics', privileges: ['connect'] }] })
      return
    }
    if (url.pathname.endsWith('/accounts/grants') && method === 'POST') {
      commands.push(request.postDataJSON())
      await route.fulfill({ json: { appliedCount: 1 } })
      return
    }
    await route.fulfill({ status: 204 })
  })

  await page.goto('/')
  await page.getByText('Integration PostgreSQL').click()
  await page.getByRole('tab', { name: '原生帳號' }).click()
  await page.getByRole('button', { name: '管理權限 reporter' }).click()
  const dialog = page.getByRole('dialog', { name: '管理資料庫權限' })
  await dialog.getByLabel('目標資料庫').fill('analytics')
  await dialog.getByRole('button', { name: '讀取實際權限' }).click()
  await expect(dialog.getByLabel('實際權限').getByText('CONNECT')).toBeVisible()
  await dialog.getByLabel('權限範圍').selectOption('table')
  await dialog.getByLabel('Schema 名稱').fill('reporting')
  await dialog.getByLabel('資料表名稱').fill('orders')
  await dialog.getByRole('checkbox', { name: 'SELECT' }).check()
  await dialog.getByRole('button', { name: '授予權限' }).click()
  await dialog.getByRole('button', { name: '撤銷權限' }).click()
  const confirmation = page.getByRole('dialog', { name: '確認撤銷權限' })
  await confirmation.getByRole('button', { name: '撤銷' }).click()

  await expect.poll(() => commands).toEqual([
    {
      kind: 'grant', identity: { engine: 'postgres', username: 'reporter' },
      changes: [{ scope: 'table', database: 'analytics', schema: 'reporting', table: 'orders', privileges: ['select'] }],
    },
    {
      kind: 'revoke', confirmed: true, identity: { engine: 'postgres', username: 'reporter' },
      changes: [{ scope: 'table', database: 'analytics', schema: 'reporting', table: 'orders', privileges: ['select'] }],
    },
  ])
})
