import { expect, test } from '@playwright/test'

test('switches language, signs in, and restores the authenticated workbench', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: '登入 DBWeb' })).toBeVisible()
  await page.getByRole('button', { name: 'English' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in to DBWeb' })).toBeVisible()
  await page.getByLabel('Username').fill('e2e-admin')
  await page.getByLabel('Password').fill('e2e secure administrator password')
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page.getByRole('heading', { name: 'Connection workbench' })).toBeVisible()
  await expect(page.getByText('e2e-admin')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: '連線工作台' })).toBeVisible()
  await expect(page.getByText('e2e-admin')).toBeVisible()
})
