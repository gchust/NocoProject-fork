/**
 * A throwaway preview of this checkout: the built client (`pnpm build`) served by the real server on an isolated
 * SQLite file, seeded with a small demo dataset, so an agent (or CI) on any machine can open the pages and take
 * screenshots without the shared development server. `pnpm screenshots` starts it through Playwright's webServer.
 *
 *   pnpm build && pnpm preview            # http://127.0.0.1:13100/main, admin nocobase / admin123
 *
 * Environment: NP_PREVIEW_PORT (13100), NP_PREVIEW_HOST (127.0.0.1), NP_PREVIEW_DIR (a temp dir removed on exit;
 * set it to keep the database between runs), NP_PREVIEW_SEED=0 skips the demo data.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startNodeAppServer } from '@nocobase/app-server/node';

import {
  createStandaloneServer,
  type StandaloneServer,
} from '../server/standalone.ts';

const ADMIN = {
  username: 'nocobase',
  password: 'admin123',
  email: 'admin@nocobase.com',
};
const AUTH_SECRET = 'preview-auth-secret-at-least-32-characters';

const rootDir = path.resolve(import.meta.dirname, '..');
const clientDir = path.join(rootDir, 'dist/client');
if (!existsSync(path.join(clientDir, 'index.html'))) {
  console.error('dist/client is missing: run `pnpm build` first.');
  process.exit(1);
}

const port = Number(process.env.NP_PREVIEW_PORT ?? 13100);
const hostname = process.env.NP_PREVIEW_HOST ?? '127.0.0.1';
const keepDir = Boolean(process.env.NP_PREVIEW_DIR);
const directory = process.env.NP_PREVIEW_DIR
  ? path.resolve(process.env.NP_PREVIEW_DIR)
  : mkdtempSync(path.join(tmpdir(), 'nocoproject-preview-'));
mkdirSync(directory, { recursive: true });
const fresh = !existsSync(path.join(directory, 'database.sqlite'));

const configFile = path.join(directory, 'config.json');
writeFileSync(
  configFile,
  JSON.stringify(
    {
      client: { app: { title: 'NocoProject 预览' } },
      i18n: { defaultLocale: 'zh-CN' },
      users: { initialAdmin: ADMIN },
      auth: {
        secret: AUTH_SECRET,
        emailAndPassword: { enabled: true, autoSignIn: false },
        session: { storeSessionInDatabase: true },
      },
      session: { secret: AUTH_SECRET },
      database: {
        default: 'main',
        connections: {
          main: {
            dialect: 'sqlite',
            filename: path.join(directory, 'database.sqlite'),
          },
        },
        migrations: { autoRun: true },
        seeds: { autoRun: true },
      },
      notification: { channels: { inbox: { provider: 'in-app' } } },
      hub: { host: { enabled: false } },
    },
    null,
    2,
  ),
);

const app = await createStandaloneServer({
  viteDevUrl: false,
  env: {
    DB_DIALECT: 'sqlite',
    DB_MIGRATIONS_AUTO_RUN: 'true',
    DB_SEEDS_AUTO_RUN: 'true',
    APP_CONFIG_FILE: configFile,
    AUTH_SECRET,
    APP_SERVER_HOST: hostname,
    APP_SERVER_PORT: String(port),
  },
  paths: {
    rootDir,
    serverDir: path.join(rootDir, 'server'),
    databaseDir: path.join(rootDir, 'database'),
    clientDir,
    storageDir: path.join(directory, 'storage'),
  },
});

const base = `http://${hostname}:${port}${app.application.publicBasePath}`;

if (fresh && process.env.NP_PREVIEW_SEED !== '0') await seedDemo(app);

await startNodeAppServer(app, {
  hostname,
  port,
  registerProcessSignals: true,
  onListen: () => {
    console.log(
      `NocoProject preview: ${base}  (sign in as ${ADMIN.username} / ${ADMIN.password})`,
    );
    console.log(
      `Data directory: ${directory}${keepDir ? '' : ' (removed on exit)'}`,
    );
  },
});

if (!keepDir) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () =>
      rmSync(directory, { recursive: true, force: true }),
    );
  process.once('exit', () =>
    rmSync(directory, { recursive: true, force: true }),
  );
}

// ---------- demo data ----------

interface Api {
  get(url: string): Promise<unknown>;
  send(method: string, url: string, body?: unknown): Promise<unknown>;
}

async function seedDemo(server: StandaloneServer): Promise<void> {
  const api = await signIn(server);
  const me = (await api.get('/np/me')) as { userId: string };
  const project = (await api.send('POST', '/np/projects', {
    name: 'NocoProject',
    description: '人与 Agent 协同的项目管理。预览数据，随进程销毁。',
    leadUserId: me.userId,
    priority: 'high',
  })) as { id: string };
  const issues: {
    title: string;
    statusKey: string;
    priority: 'urgent' | 'high' | 'medium' | 'low';
    description: string;
  }[] = [
    {
      title: '收件箱主从布局在窄屏下折叠为列表 → 详情',
      statusKey: 'in_progress',
      priority: 'high',
      description:
        '## 目标\n\n窄于 `lg` 时收件箱只显示列表，点开一项后覆盖显示详情，返回键回到列表。\n\n- 保持 `j` / `k` / `e` 快捷键\n- URL 里的 `?item=` 不变',
    },
    {
      title: '看板列头用语义色圆点，去掉工作流颜色名',
      statusKey: 'in_review',
      priority: 'medium',
      description: '按 `statusTone` 取色：待验收紫、受阻琥珀、进行中蓝。',
    },
    {
      title: '报表页按 Agent 汇总 token 与成本',
      statusKey: 'todo',
      priority: 'medium',
      description:
        '设置里的模型价格 × 运行记录的 token，按 Agent 与项目两个维度汇总。',
    },
    {
      title: 'Webhook 转发断线后自动重连',
      statusKey: 'blocked',
      priority: 'urgent',
      description:
        '`gh webhook forward` 断线后 launchd 不会拉起，需要 KeepAlive 或改成轮询兜底。',
    },
    {
      title: '任务详情页只保留一个滚动容器',
      statusKey: 'done',
      priority: 'low',
      description: '主列与侧列都不再各自滚动，评论输入框 `sticky bottom-0`。',
    },
    {
      title: '知识库文档的版本对照视图',
      statusKey: 'backlog',
      priority: 'low',
      description: '`kb propose` 的建议以 diff 形式展示在决定卡里。',
    },
  ];
  let first: { id: string; revision: number } | null = null;
  for (const spec of issues) {
    const created = (await api.send('POST', '/np/issues', {
      title: spec.title,
      description: spec.description,
      priority: spec.priority,
      projectId: project.id,
      ownerUserId: me.userId,
      start: false,
    })) as { id: string; revision: number; statusKey: string };
    let issue = created;
    if (created.statusKey !== spec.statusKey) {
      const patched = (await api.send('PATCH', `/np/issues/${created.id}`, {
        statusKey: spec.statusKey,
        revision: created.revision,
        start: false,
      })) as { issue?: { id: string; revision: number } } & {
        id?: string;
        revision?: number;
      };
      issue = { ...created, ...(patched.issue ?? patched) } as typeof created;
    }
    first ??= issue;
  }
  if (first) {
    await api.send('POST', `/np/issues/${first.id}/comments`, {
      content:
        '方案已提交，改动点：\n\n1. `InboxPage` 按 `useMediaQuery("(min-width: 64rem)")` 切换单列 / 双列\n2. 列表项点击后 `navigate("?item=<id>")`\n\n```tsx\nconst wide = useMediaQuery(\'(min-width: 64rem)\');\n```\n\n请验收。',
    });
    await api.send('POST', `/np/issues/${first.id}/comments`, {
      content: '窄屏下返回按钮请放在吸顶动作条最左侧，和《前端标准》§4 一致。',
    });
  }
  console.log(
    `Seeded demo data: project ${project.id}, ${issues.length} issues.`,
  );
}

async function signIn(server: StandaloneServer): Promise<Api> {
  const apiBase = `http://localhost${server.application.publicBasePath}/api`;
  const signInResponse = await server.fetch(
    new Request(`${apiBase}/auth/sign-in/username`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify({
        username: ADMIN.username,
        password: ADMIN.password,
      }),
    }),
  );
  if (signInResponse.status !== 200)
    throw new Error(`sign-in failed: ${signInResponse.status}`);
  const cookie = signInResponse.headers
    .getSetCookie()
    .map((header) => header.split(';')[0])
    .join('; ');
  const created = await server.fetch(
    new Request(`${apiBase}/auth/api-key/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost',
      },
      body: JSON.stringify({ name: 'preview-seed' }),
    }),
  );
  if (!created.ok)
    throw new Error(
      `api-key/create failed: ${created.status} ${await created.text()}`,
    );
  const { key } = (await created.json()) as { key: string };
  const unwrap = async (response: Response, what: string) => {
    if (!response.ok)
      throw new Error(`${what} → ${response.status} ${await response.text()}`);
    const body = (await response.json()) as { data?: unknown };
    return body.data ?? body;
  };
  return {
    get: async (url) =>
      unwrap(
        await server.fetch(
          new Request(`${apiBase}${url}`, { headers: { cookie } }),
        ),
        `GET ${url}`,
      ),
    send: async (method, url, body) =>
      unwrap(
        await server.fetch(
          new Request(`${apiBase}${url}`, {
            method,
            headers: { 'x-api-key': key, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        ),
        `${method} ${url}`,
      ),
  };
}
