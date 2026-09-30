// @vitest-environment node
/** Built CLI -> real run-token routes -> PostgreSQL, then actual claim payload -> CLI brief. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildBrief,
  buildTurnPrompt,
} from '../../../nocoproject-cli/src/daemon/brief.ts';
import {
  buildRunContext,
  type ClaimedRunV1,
} from '../../../nocoproject-cli/src/run-context.ts';
import { createAgentPmRoutes } from '../../server/modules/pm/pm.routes.ts';
import {
  createAgentApiRoutes,
  runTokenAuth,
} from '../../server/modules/run/agent-api.routes.ts';
import { guarded, npRouter } from '../../server/modules/shared/http.ts';
import {
  PROTOCOL_VERSION,
  type PmActResult,
  type PmPlan,
  type PmConversationDetail,
} from '../../server/modules/shared/protocol.ts';
import {
  ALICE,
  CAROL,
  buildServices,
  claimOne,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  rows,
  setRole,
  type NpTestDatabase,
} from './np-harness.ts';
import { browserApi4, createKindAgent } from './np-iter4-harness.ts';

const opened =
  process.env.NP_PM_CLI_INTEGRATION === '1'
    ? await openNpTestDatabase('np_t_pm_cli')
    : {
        skip: 'Build nocoproject-cli and set NP_PM_CLI_INTEGRATION=1 to run the cross-package integration.',
      };
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn('[np-pm-cli] skipped: ' + skip);
const db = (skip ? null : opened) as NpTestDatabase | null;
afterAll(async () => {
  await db?.close();
});

describe.skipIf(!db)('PM CLI with the real server and PostgreSQL', () => {
  it('gates claims, writes within budget, submits a plan and renders its executed result', async () => {
    const cli = resolve('../nocoproject-cli/dist/cli.js');
    expect(
      existsSync(cli),
      'Build nocoproject-cli before this integration test',
    ).toBe(true);
    await resetData(db!);
    const { services } = buildServices(db!.database);
    await setRole(db!, ALICE, 'member');
    await setRole(db!, CAROL, 'owner');
    const fixture = await registerRuntime(services, CAROL, 'pm-cli-test');
    const manager = await createKindAgent(
      services,
      CAROL,
      fixture.runtimeId,
      'PM',
      'manager',
    );
    const settings = await services.workspaceSettings.view(CAROL);
    await services.workspaceSettings.update(CAROL, {
      agentEntries: {
        ...settings.agentEntries!,
        conversation: {
          ...settings.agentEntries!.conversation,
          agentId: manager,
          enabled: true,
          instructions: 'Read manual first; ask one key question.',
        },
      },
    });
    const alice = browserApi4(services, ALICE);
    const created = await alice<{ data: PmConversationDetail }>(
      'POST',
      '/np/pm/conversations',
      {},
    );
    expect(created.status).toBe(201);
    const conversation = created.body.data;
    await alice('POST', '/np/issues/' + conversation.id + '/comments', {
      content: 'Prepare release tasks',
      context: {
        route: '/issues',
        items: [],
        selection: { text: 'release scope' },
      },
    });
    await services.runtimes.register(CAROL.id!, {
      daemonId: fixture.daemonId,
      deviceName: 'test-device',
      version: '0.5.3',
      protocolVersion: PROTOCOL_VERSION,
      runtimes: [
        {
          provider: 'echo',
          version: '1.0.0',
          capabilities: { resume: true, steering: false },
        },
      ],
    });
    expect(await claimOne(services, CAROL, fixture)).toBeUndefined();
    await registerRuntime(services, CAROL, fixture.daemonId);
    const claimed = (await claimOne(services, CAROL, fixture)) as ClaimedRunV1;
    expect(claimed).toBeDefined();
    expect(claimed.issue.identifier).toBe('');
    expect(claimed.issue.conversation?.asker.userId).toBe(ALICE.id);
    expect(buildRunContext(claimed).issue.identifier).toBe(conversation.id);
    const brief = buildBrief(claimed);
    expect(brief).toContain('Read manual first; ask one key question.');
    expect(brief).toContain('server supplied no repository whitelist');
    expect(brief.indexOf('## Task instructions')).toBeLessThan(
      brief.indexOf('## Asker'),
    );
    expect(brief.indexOf('## Asker')).toBeLessThan(
      brief.indexOf('## Personal preferences'),
    );
    const firstPrompt = buildTurnPrompt(claimed, { resumed: false });
    expect(firstPrompt).toContain('[PAGE CONTEXT]');
    expect(firstPrompt).toContain('> release scope');
    expect(firstPrompt).toContain('issue comment list ' + conversation.id);

    // NP-114 can append a message to an already-running PM session; its own context must survive.
    await services.runs.start(claimed.run.id, {
      workDir: '/tmp/pm-cli-test',
      acceptsInput: true,
    });
    await alice('POST', '/np/issues/' + conversation.id + '/comments', {
      content: 'Use this page now',
      context: {
        route: '/inbox',
        items: [],
        selection: { text: 'new selection' },
      },
    });
    const status = await services.runs.daemonStatus(claimed.run.id);
    const latest = status.inputs!.find(
      (input) => input.content === 'Use this page now',
    )!;
    expect(latest).toBeDefined();
    const livePrompt = buildTurnPrompt(
      { ...claimed, triggers: [{ type: 'comment', comment: latest }] },
      { resumed: true },
    );
    expect(livePrompt).toContain('[PAGE CONTEXT]');
    expect(livePrompt).toContain('/inbox');
    expect(livePrompt).toContain('> new selection');
    expect(livePrompt).not.toContain('> release scope');

    const routes = npRouter().route(
      '/api/np/agent',
      guarded(
        [runTokenAuth(services.runTokens)],
        createAgentPmRoutes(services.pm, {
          act: services.pmAct,
          conversations: services.pmConversations,
          plans: services.pmPlans,
        }),
        createAgentApiRoutes({
          issues: services.issues,
          queries: services.issueQueries,
          comments: services.comments,
          agentIssues: services.agentIssues,
          pullRequests: services.pullRequests,
        }),
      ),
    );
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const response = await routes.request('http://localhost' + req.url, {
          method: req.method,
          headers: {
            'content-type': 'application/json',
            authorization: req.headers.authorization ?? '',
          },
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.writeHead(500);
        res.end('Test transport failed');
      }
    });
    const dir = mkdtempSync(join(tmpdir(), 'np-pm-cli-'));
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No test listener');
    const serverUrl = 'http://127.0.0.1:' + address.port;
    async function run(args: string[], token = claimed.token) {
      const child = spawn(process.execPath, [cli, ...args, '--json'], {
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          NOCOPROJECT_HOME: dir,
          NOCOPROJECT_SERVER_URL: serverUrl,
          NOCOPROJECT_TOKEN: token,
        },
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (data) => {
        out += data;
      });
      child.stderr.on('data', (data) => {
        err += data;
      });
      const code = await new Promise<number | null>((resolve) =>
        child.on('close', resolve),
      );
      return { code, out, err };
    }
    function jsonFile(name: string, data: unknown) {
      const file = join(dir, name);
      writeFileSync(file, JSON.stringify(data));
      return file;
    }
    try {
      const roster = await run(['pm', 'agents']);
      expect({ code: roster.code, err: roster.err }).toEqual({
        code: 0,
        err: '',
      });
      expect(JSON.parse(roster.out)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: manager, canInvoke: true }),
        ]),
      );
      const params = (title: string) =>
        jsonFile('params.json', { title, process: 'direct' });
      const first = await run([
        'pm',
        'do',
        'issue.create',
        '--params-file',
        params('CLI first'),
      ]);
      expect({ code: first.code, err: first.err }).toEqual({
        code: 0,
        err: '',
      });
      const direct = JSON.parse(first.out) as PmActResult;
      expect(direct.budget).toEqual({ used: 1, limit: 2 });
      const second = await run([
        'pm',
        'do',
        'issue.create',
        '--params-file',
        params('CLI second'),
      ]);
      expect({ code: second.code, err: second.err }).toEqual({
        code: 0,
        err: '',
      });
      const third = await run([
        'pm',
        'do',
        'issue.create',
        '--params-file',
        params('CLI planned'),
      ]);
      expect(third.code).toBe(3);
      expect(JSON.parse(third.out).error).toMatchObject({
        code: 'PLAN_REQUIRED',
        details: { reason: 'budget' },
      });
      expect(
        await rows(db!, 'issues', "title = 'CLI planned'", []),
      ).toHaveLength(0);
      for (const command of [
        ['pm', 'runs', direct.object.identifier!],
        ['pm', 'prs', direct.object.id],
        ['pm', 'run', claimed.run.id, '--events', '--limit', '1'],
      ]) {
        const result = await run(command);
        expect({ code: result.code, err: result.err }).toEqual({
          code: 0,
          err: '',
        });
      }
      const title = await run(['pm', 'conversation', 'title', 'Release plan']);
      expect({ code: title.code, err: title.err }).toEqual({
        code: 0,
        err: '',
      });
      expect(JSON.parse(title.out).title).toBe('Release plan');
      const submitted = await run([
        'pm',
        'plan',
        'create',
        '--file',
        jsonFile('plan.json', {
          title: 'Remaining work',
          ops: [
            {
              type: 'issue.create',
              ref: 'remaining',
              params: { title: 'CLI planned', process: 'direct' },
            },
          ],
        }),
      ]);
      expect({ code: submitted.code, err: submitted.err }).toEqual({
        code: 0,
        err: '',
      });
      const plan = JSON.parse(submitted.out) as PmPlan;
      expect(plan.status).toBe('pending');
      expect(
        await rows(db!, 'issues', "title = 'CLI planned'", []),
      ).toHaveLength(0);
      await services.runs.complete(claimed.run.id, {
        providerSessionId: 'pm-cli-session',
        workDir: dir,
        handledInputIds: status.inputs!.map((input) => input.id),
      });
      // The human test actor executes through the real browser route; no CLI execute command exists.
      const executed = await alice<{ data: PmPlan }>(
        'POST',
        '/np/pm/plans/' + plan.id + '/execute',
        { revision: plan.revision },
      );
      expect(executed.status).toBe(200);
      expect(executed.body.data.status).toBe('executed');
      expect(
        await rows(db!, 'issues', "title = 'CLI planned'", []),
      ).toHaveLength(1);
      const resumed = (await claimOne(
        services,
        CAROL,
        fixture,
      )) as ClaimedRunV1;
      expect(resumed.triggers[0]?.plan).toMatchObject({
        planId: plan.id,
        status: 'executed',
      });
      const prompt = buildTurnPrompt(resumed, { resumed: true });
      expect(prompt).toContain('[PLAN RESULT]');
      expect(prompt).toContain(plan.id);
      expect(prompt).toContain(executed.body.data.rows[0]!.resultId);
      expect(prompt).not.toContain('[NEW COMMENT]');
      const read = await run(['pm', 'plan', 'get', plan.id], resumed.token);
      expect({ code: read.code, err: read.err }).toEqual({ code: 0, err: '' });
      expect(JSON.parse(read.out).result.status).toBe('executed');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
