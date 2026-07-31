import { expect, test } from '@playwright/test'

test('keeps the authenticated workbench separated at desktop and mobile sizes', async ({
  browserName,
  page,
}) => {
  test.skip(browserName !== 'chromium', 'One rendering engine is sufficient for geometry screenshots')

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.getByLabel('使用者名稱').fill('e2e-admin')
  await page.getByLabel('密碼').fill('e2e secure administrator password')
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await expect(page.getByRole('heading', { name: '連線工作台' })).toBeVisible()

  await expectNoPageOverflow(page)
  const desktop = await layoutBoxes(page)
  expect(desktop.rail.right).toBeLessThanOrEqual(desktop.workspace.left)
  expect(desktop.topbar.bottom).toBeLessThanOrEqual(desktop.workspace.top)
  await page.screenshot({ path: 'test-results/dbweb-desktop.png', fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await expectNoPageOverflow(page)
  const mobile = await layoutBoxes(page)
  expect(mobile.topbar.bottom).toBeLessThanOrEqual(mobile.rail.top)
  expect(mobile.rail.bottom).toBeLessThanOrEqual(mobile.workspace.top)
  await page.screenshot({ path: 'test-results/dbweb-mobile.png', fullPage: true })
})

async function expectNoPageOverflow(page: import('@playwright/test').Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true)
}

async function layoutBoxes(page: import('@playwright/test').Page) {
  const boxes = await page.locator('.topbar, .connection-rail, .workspace').evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect()
      return { top: box.top, right: box.right, bottom: box.bottom, left: box.left }
    }),
  )
  if (boxes.length !== 3) throw new Error('Expected topbar, connection rail, and workspace')
  return { topbar: boxes[0]!, rail: boxes[1]!, workspace: boxes[2]! }
}
