import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const base = (
  process.env.NP_PREVIEW_URL ?? 'http://127.0.0.1:13100/main'
).replace(/\/$/, '');
const output = path.resolve('output/screenshots/profile');

test('member profile, password, menu, responsive themes and reload', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1360, height: 900 },
  });
  const suffix = Date.now().toString();
  const username = `profile${suffix}`;
  const password = 'Profile-test-1234';
  const origin = new URL(base).origin;
  const post = (endpoint: string, data: unknown) =>
    context.request.post(`${base}/api/auth/${endpoint}`, {
      data,
      headers: { origin },
    });
  expect(
    (
      await post('sign-up/email', {
        name: 'Profile Tester',
        username,
        email: `${username}@example.com`,
        password,
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (await post('sign-in/username', { username, password })).ok(),
  ).toBeTruthy();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/inbox`);
  await page.getByRole('button', { name: '打开账户菜单' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: '个人资料' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${base}/profile`);
  await expect(page.getByLabel('显示名称 *')).toHaveValue('Profile Tester');
  await page.reload();
  await expect(page.getByLabel('用户名 *')).toHaveValue(username);
  const name = page.getByLabel('显示名称 *');
  await name.fill('');
  await name.pressSequentially('Profile Updated');
  await name.press('Home');
  await name.pressSequentially('New ');
  await expect(name).toHaveValue('New Profile Updated');
  await name.dispatchEvent('compositionstart');
  await name.fill('周测试');
  await name.dispatchEvent('compositionend', { data: '周测试' });
  await expect(name).toHaveValue('周测试');
  await page.getByLabel('用户名 *').fill('nocobase');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('该用户名已被使用，请更换。')).toBeVisible();
  await expect(page.getByLabel('用户名 *')).toBeFocused();
  await page.getByLabel('用户名 *').fill(`${username}x`);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('个人资料已保存', { exact: true })).toBeVisible();
  await page.reload();
  await expect(name).toHaveValue('周测试');
  await expect(page.getByLabel('用户名 *')).toHaveValue(`${username}x`);
  await page.getByLabel('当前密码 *').fill('wrong-password');
  await page.getByLabel('新密码 *', { exact: true }).fill('Changed-test-1234');
  await page.getByLabel('确认新密码 *').fill('mismatch');
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  await expect(page.getByText('两次输入的密码不一致。')).toBeVisible();
  await page.getByLabel('确认新密码 *').fill('Changed-test-1234');
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  await expect(page.getByText('当前密码不正确，请重试。')).toBeVisible();
  await expect(page.getByLabel('当前密码 *')).toBeFocused();
  await page.getByLabel('当前密码 *').fill(password);
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  await expect(page.getByText('密码已修改', { exact: true })).toBeVisible();
  await expect(page.getByLabel('当前密码 *')).toHaveValue('');
  await expect(page.getByLabel('新密码 *', { exact: true })).toHaveValue('');
  await page.reload();
  await expect(name).toHaveValue('周测试');
  expect(
    (
      await post('sign-in/username', { username: `${username}x`, password })
    ).ok(),
  ).toBeFalsy();
  expect(
    (
      await post('sign-in/username', {
        username: `${username}x`,
        password: 'Changed-test-1234',
      })
    ).ok(),
  ).toBeTruthy();
  mkdirSync(output, { recursive: true });
  const scope =
    encodeURIComponent(new URL(base).pathname.replace(/^\/+|\/+$/g, '')) ||
    '%2F';
  for (const preset of ['compact', 'default']) {
    for (const mode of ['light', 'dark']) {
      await page.evaluate(
        ({ scope, preset, mode }) => {
          localStorage.setItem(`nocobase:${scope}:theme:preset`, preset);
          localStorage.setItem(`nocobase:${scope}:theme:color-scheme`, mode);
        },
        { scope, preset, mode },
      );
      await page.reload();
      await expect(name).toHaveValue('周测试');
      await page.screenshot({
        path: path.join(output, `${preset}-${mode}.png`),
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({
    path: path.join(output, 'mobile.png'),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      'document.documentElement.scrollWidth <= window.innerWidth',
    ),
  ).toBeTruthy();
  await page
    .getByRole('button', { name: '修改密码', exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole('button', { name: '修改密码', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(output, 'mobile-password.png'),
    fullPage: true,
  });
  // A reconnect reload must not discard or steal focus from unsaved drafts.
  await name.fill('Unsaved draft');
  await page.getByLabel('当前密码 *').fill('draft-password');
  await page.route('**/api/auth/get-session?disableCookieCache=true', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'UNAVAILABLE' }),
    }),
  );
  await page.evaluate("window.dispatchEvent(new Event('offline'))");
  await page.evaluate("window.dispatchEvent(new Event('online'))");
  await expect(
    page.getByText('账户信息刷新失败，已保留当前输入，请重试。'),
  ).toBeVisible();
  await expect(name).toHaveValue('Unsaved draft');
  await expect(page.getByLabel('当前密码 *')).toHaveValue('draft-password');
  await expect(page.getByLabel('当前密码 *')).toBeFocused();
  await page.unroute('**/api/auth/get-session?disableCookieCache=true');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(
    page.getByText('账户信息刷新失败，已保留当前输入，请重试。'),
  ).toHaveCount(0);
  await expect(name).toHaveValue('Unsaved draft');
  await expect(page.getByLabel('当前密码 *')).toHaveValue('draft-password');
  expect(errors).toEqual([]);
  await context.close();
});
