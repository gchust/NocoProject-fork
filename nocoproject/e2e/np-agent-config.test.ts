import { expect, test } from '@playwright/test';

const base = process.env.NP_PREVIEW_URL ?? 'http://127.0.0.1:13100/main';

test('configuration controls instructions, capabilities and entry names', async ({
  page,
  context,
}) => {
  test.setTimeout(45_000);
  page.setDefaultTimeout(10_000);
  const request = context.request;
  const login = await request.post(`${base}/api/auth/sign-in/username`, {
    data: { username: 'nocobase', password: 'admin123' },
    headers: { origin: new URL(base).origin },
  });
  expect(login.ok()).toBeTruthy();
  const registered = await request.post(`${base}/api/np/daemon/register`, {
    headers: { origin: new URL(base).origin },
    data: {
      daemonId: 'np125-browser',
      deviceName: 'Browser verification',
      version: '0.4.0',
      protocolVersion: 1,
      runtimes: [
        {
          provider: 'echo',
          version: '1',
          capabilities: { resume: true, steering: false },
        },
      ],
    },
  });
  expect(registered.ok(), await registered.text()).toBeTruthy();
  const runtimeId = (await registered.json()).data.runtimes[0].id;
  const created = await request.post(`${base}/api/np/agents`, {
    headers: { origin: new URL(base).origin },
    data: {
      name: '配置助手',
      instructions: '只提供建议，不拆分任务。',
      provider: 'echo',
      runtimeId,
      capabilities: ['context.read', 'comment.create'],
      access: 'everyone',
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const agent = (await created.json()).data;
  await page.goto(`${base}/agents/${agent.id}`);
  await page
    .locator('#np-agent-edit-instructions')
    .fill('职责已修改：回答问题并引用依据。');
  await page.getByText('有效指令预览', { exact: true }).click();
  await expect(page.locator('details pre').first()).toHaveText(
    '职责已修改：回答问题并引用依据。',
  );
  await expect(page.locator('details')).not.toContainText('issue create');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get(`${base}/api/np/agents`)).json()).data.find(
          (value: { id: string }) => value.id === agent.id,
        ).instructions,
    )
    .toBe('职责已修改：回答问题并引用依据。');
  await page.goto(`${base}/config/general`);
  await page.locator('#np-entry-conversation-name').fill('研究助理');
  await page.locator('#np-entry-conversation-agent').click();
  await page.getByRole('option', { name: '配置助手', exact: true }).click();
  const enabled = page
    .getByRole('group', { name: '对话入口', exact: true })
    .getByRole('switch');
  if ((await enabled.getAttribute('aria-checked')) !== 'true')
    await enabled.click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get(`${base}/api/np/settings`)).json()).data
          .agentEntries.conversation.name,
    )
    .toBe('研究助理');
  await page.goto(`${base}/pm`);
  await expect(
    page.getByRole('heading', { name: '研究助理', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: '研究助理', exact: true }),
  ).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.screenshot({
    path: 'output/screenshots/np125-configured-conversation.png',
    fullPage: true,
  });
});
