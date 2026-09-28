import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowDefinitionV5 } from '../src/protocol.js';
import { parseChecklistArgs } from '../src/cli/checklist.js';
import { MockServer } from './helpers/mock-server.js';

const CLI = join(__dirname, '..', 'dist', 'cli.js');
const DEFINITION: WorkflowDefinitionV5 = {
  statuses: [
    { key: 'todo', name: 'Todo', category: 'unstarted', color: 'gray', builtIn: true },
    { key: 'in_review', name: 'In Review', category: 'started', color: 'purple', builtIn: true, onEnter: [{ type: 'notifyOwner' }] },
    { key: 'done', name: 'Done', category: 'done', color: 'green', builtIn: true },
  ],
  transitions: [{ from: '*', to: '*', actors: ['user'] }],
  childBatchDoneWakesParentExecutor: true,
};
const item = (itemKey: string, label: string, required: boolean, checked = false) => ({ itemKey, label, required, checked, checkedByType: null, checkedById: null, checkedByName: null, checkedAt: null });

let mock: MockServer;
let token: string;
let workDir: string;

beforeAll(async () => {
  mock = new MockServer();
  await mock.start();
  mock.runtimes.set('echo', { id: 'rt-echo', provider: 'echo' });
  mock.addIssue({ id: 'i50', identifier: 'NP-50', title: 'Workflow issue' });
  mock.workflow.add({ id: 'default', name: '软件开发', isSystem: true, isDefault: true, usedByRunProject: true, projectCount: 3, definition: DEFINITION });
  mock.workflow.add({ id: 'wf-team', name: 'Team flow', revision: 4, projectCount: 1, definition: DEFINITION });
  mock.workflow.checklists.set('i50', [{ statusKey: 'in_review', current: true, complete: false, items: [item('tests', 'Tests pass', true), item('docs', 'Docs', false)] }]);
  token = mock.issueToken('i50');
  workDir = mkdtempSync(join(tmpdir(), 'ncp-wf-'));
});
afterAll(async () => mock.stop());

function run(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: workDir,
    env: { PATH: process.env.PATH, HOME: workDir, NOCOPROJECT_HOME: workDir, NOCOPROJECT_SERVER_URL: mock.url, NOCOPROJECT_TOKEN: token, NOCOPROJECT_ISSUE_ID: 'i50', NOCOPROJECT_ISSUE_KEY: 'NP-50' },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
}

describe('workflow list / get', () => {
  it('lists the templates and marks the run project’s one', async () => {
    const json = await run(['workflow', 'list', '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out).map((t: { id: string }) => t.id)).toEqual(['default', 'wf-team']);
    const text = await run(['workflow', 'list']);
    expect(text.out).toContain('default  软件开发  (rev 1, system: copy only, default, 3 projects)  ← this run’s project');
    expect(text.out).toContain('wf-team  Team flow  (rev 4, 1 project)');
  });

  it('gets the run project’s template by default and prints the definition to edit', async () => {
    const text = await run(['workflow', 'get']);
    expect(text.code).toBe(0);
    expect(text.out).toContain('  in_review  In Review  [started] built-in  onEnter: notifyOwner');
    expect(text.out).toContain('nocoproject workflow get default --definition > wf.json');
    const definition = await run(['workflow', 'get', 'wf-team', '--definition']);
    expect(JSON.parse(definition.out)).toEqual(DEFINITION);
    const missing = await run(['workflow', 'get', 'nope', '--json']);
    expect(missing.code).toBe(4);
  });
});

describe('workflow propose', () => {
  it('proposes a change to a template from a definition file (a whole template is unwrapped)', async () => {
    const next = { ...DEFINITION, statuses: [...DEFINITION.statuses, { key: 'qa', name: 'QA', category: 'started', color: 'blue', builtIn: false }] };
    writeFileSync(join(workDir, 'wf.json'), JSON.stringify({ id: 'wf-team', definition: next }));
    const r = await run(['workflow', 'propose', 'wf-team', '--definition-file', 'wf.json', '--reason', 'Add QA.']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^proposed a change to Team flow \(base revision 4\) \(proposal wp\d+, pending\); an owner\/admin decides/);
    expect(r.out).toContain('  statuses added: qa');
    expect(mock.callsTo(/POST \/np\/agent\/workflows\/proposals/).at(-1)?.body).toEqual({ templateId: 'wf-team', definition: next, reason: 'Add QA.' });
    const again = await run(['workflow', 'propose', 'wf-team', '--definition-file', 'wf.json', '--reason', 'Again', '--json']);
    expect(again.code).toBe(5);
    expect(JSON.parse(again.out).error.code).toBe('WORKFLOW_PROPOSAL_PENDING');
  });

  it('copies a system template, and refuses editing it', async () => {
    writeFileSync(join(workDir, 'copy.json'), JSON.stringify(DEFINITION));
    const refused = await run(['workflow', 'propose', 'default', '--definition-file', 'copy.json', '--reason', 'x', '--json']);
    expect(refused.code).toBe(5);
    expect(JSON.parse(refused.out).error.code).toBe('WORKFLOW_SYSTEM_TEMPLATE');
    const copy = await run(['workflow', 'propose', '--copy-from', 'default', '--name', '软件开发（评审）', '--definition-file', 'copy.json', '--reason', 'Copy it.', '--json']);
    expect(copy.code).toBe(0);
    expect(JSON.parse(copy.out)).toMatchObject({ kind: 'copy', copyFromId: 'default', name: '软件开发（评审）', status: 'pending' });
  });

  it('prints every field error of an invalid definition', async () => {
    writeFileSync(join(workDir, 'bad.json'), JSON.stringify({ ...DEFINITION, statuses: [DEFINITION.statuses[0]] }));
    const text = await run(['workflow', 'propose', '--copy-from', 'wf-team', '--name', 'Bad', '--definition-file', 'bad.json', '--reason', 'x']);
    expect(text.code).toBe(5);
    expect(text.err).toContain('INVALID_WORKFLOW');
    expect(text.err).toContain('  - statuses: The built-in status in_review cannot be removed.');
    expect(text.err).toContain('  - statuses: The built-in status done cannot be removed.');
    const json = JSON.parse((await run(['workflow', 'propose', '--copy-from', 'wf-team', '--name', 'Bad', '--definition-file', 'bad.json', '--reason', 'x', '--json'])).out);
    expect(json.error.details.issues).toHaveLength(2);
  });

  it('validates the flags and the file before calling the server', async () => {
    writeFileSync(join(workDir, 'broken.json'), '{ not json');
    const before = mock.callsTo(/workflows\/proposals/).length;
    const cases: [string[], string][] = [
      [['--definition-file', 'wf.json', '--reason', 'x'], 'INVALID_ARGUMENTS'],
      [['wf-team', '--copy-from', 'default', '--name', 'N', '--definition-file', 'wf.json', '--reason', 'x'], 'INVALID_ARGUMENTS'],
      [['--copy-from', 'default', '--definition-file', 'wf.json', '--reason', 'x'], 'NAME_REQUIRED'],
      [['wf-team', '--definition-file', 'wf.json'], 'REASON_REQUIRED'],
      [['wf-team', '--definition-file', 'wf.json', '--reason', 'x'.repeat(501)], 'REASON_TOO_LONG'],
      [['wf-team', '--reason', 'x'], 'DEFINITION_REQUIRED'],
      [['wf-team', '--definition-file', 'missing.json', '--reason', 'x'], 'FILE_NOT_FOUND'],
      [['wf-team', '--definition-file', 'broken.json', '--reason', 'x'], 'INVALID_JSON'],
    ];
    for (const [args, code] of cases) {
      const r = await run(['workflow', 'propose', ...args, '--json']);
      expect(r.code, args.join(' ')).toBe(5);
      expect(JSON.parse(r.out).error.code, args.join(' ')).toBe(code);
    }
    expect(mock.callsTo(/workflows\/proposals/).length).toBe(before);
  });
});

describe('issue checklist', () => {
  it('parses the optional issue before check / uncheck', () => {
    expect(parseChecklistArgs([])).toEqual({});
    expect(parseChecklistArgs(['NP-1'])).toEqual({ issue: 'NP-1' });
    expect(parseChecklistArgs(['check', 'tests'])).toEqual({ op: 'check', item: 'tests' });
    expect(parseChecklistArgs(['NP-1', 'uncheck', 'in_review/tests'])).toEqual({ issue: 'NP-1', op: 'uncheck', item: 'in_review/tests' });
    expect(() => parseChecklistArgs(['NP-1', 'tick', 'tests'])).toThrow(/unknown action/);
    expect(() => parseChecklistArgs(['check'])).toThrow(/needs an item/);
  });

  it('shows the checklists and checks an item of the current status', async () => {
    const text = await run(['issue', 'checklist']);
    expect(text.code).toBe(0);
    expect(text.out).toContain('in_review (current)  required items open\n  [ ] tests  Tests pass  (required)\n  [ ] docs  Docs\n');
    const checked = await run(['issue', 'checklist', 'NP-50', 'check', 'tests']);
    expect(checked.code).toBe(0);
    expect(checked.out).toBe('checked in_review/tests (1/1 required items checked)\n');
    expect(mock.callsTo(/PATCH \/np\/agent\/issues\/i50\/checklists\/in_review\/items\/tests/).at(-1)?.body).toEqual({ checked: true });
    const json = JSON.parse((await run(['issue', 'checklist', 'uncheck', 'in_review/tests', '--json'])).out);
    expect(json).toMatchObject({ statusKey: 'in_review', complete: false });
    const missing = await run(['issue', 'checklist', 'check', 'nope', '--json']);
    expect(missing.code).toBe(4);
  });
});
