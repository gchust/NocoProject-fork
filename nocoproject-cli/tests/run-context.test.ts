import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAgentEnv, filterAgentEnv } from '../src/daemon/env.js';
import { checkoutExtras } from '../src/daemon/runner.js';
import { buildRunContext, findWorkDir, readCheckoutRecord, readRunContext, writeCheckoutRecord, writeRunContext } from '../src/run-context.js';
import { claimedRun, iter2Run, iter3Run, phase1Run } from './helpers/fixtures.js';

describe('run context', () => {
  it('fills defaults for a Phase 0 claim payload', () => {
    expect(buildRunContext(claimedRun())).toEqual({
      version: 1,
      runId: '7301234567890123',
      agent: { id: 'a1', name: 'Coder', delegationTargets: [], kind: 'coder' },
      issue: { id: 'i12', identifier: 'NP-12', title: 'Fix login redirect', parent: null, stage: null, autoExecuteSubtasks: false, projectId: null, executionMode: 'task', pullRequests: [], process: 'direct', designApprovedAt: null },
      project: null,
      knowledge: [],
      session: { branchName: null, repoUrl: null },
    });
  });

  it('writes the iteration-3 knowledge index field by field, skipping malformed entries', () => {
    const run = iter3Run();
    const bad = [...(run.knowledge ?? []), { id: 'x', slug: '', title: 'No slug', summary: '', projectId: null }, { id: 'kd3', slug: 'extra', title: 'Extra', content: 'SECRET BODY', projectId: undefined } as any];
    const ctx = buildRunContext({ ...run, knowledge: bad });
    expect(ctx.knowledge).toEqual([
      { id: 'kd1', slug: 'api-conventions', title: 'API conventions', summary: 'Error envelope,\npagination and naming rules.', projectId: 'p1' },
      { id: 'kd2', slug: 'release-process', title: 'Release process', summary: '', projectId: null },
      { id: 'kd3', slug: 'extra', title: 'Extra', summary: '', projectId: null },
    ]);
    expect(JSON.stringify(ctx)).not.toContain('SECRET BODY');
    expect(buildRunContext({ ...run, knowledge: null }).knowledge).toEqual([]);
  });

  it('carries the Phase 1 extras and never the run token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ncp-ctx-'));
    const run = phase1Run();
    const path = writeRunContext(dir, run);
    const ctx = readRunContext(dir);
    expect(ctx).toMatchObject({ project: run.project, issue: { stage: 2, autoExecuteSubtasks: true, parent: { identifier: 'NP-10' } }, session: { branchName: 'agent/coder/np-12' } });
    expect(JSON.stringify(ctx)).not.toContain(run.token);
    expect(path).toBe(join(dir, '.nocoproject', 'context.json'));
  });

  it('adds executionMode and pullRequests and never writes agent env or skills', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ncp-ctx2-'));
    const run = iter2Run({ executionMode: 'session' });
    writeRunContext(dir, run);
    const text = readFileSync(join(dir, '.nocoproject', 'context.json'), 'utf8');
    expect(JSON.parse(text).issue).toMatchObject({ executionMode: 'session', pullRequests: [{ number: 42, url: 'https://github.com/nocobase/nocoproject/pull/42', state: 'open' }] });
    expect(text).not.toContain('deploy-secret-value-123');
    expect(text).not.toContain('DEPLOY_TOKEN');
    expect(text).not.toContain('make deploy');
  });

  it('adds the iteration-4 process, design approval and agent kind, never the proposal or reasoning effort', () => {
    const run = iter2Run({ process: 'design_first', designApprovedAt: '2026-10-01T00:00:00.000Z', designProposal: { commentId: 'c1', content: 'PROPOSAL BODY', createdAt: '2026-10-01T00:00:00.000Z' } }, { kind: 'manager', reasoningEffort: 'high' });
    const ctx = buildRunContext(run);
    expect(ctx.issue).toMatchObject({ process: 'design_first', designApprovedAt: '2026-10-01T00:00:00.000Z' });
    expect(ctx.agent.kind).toBe('manager');
    expect(JSON.stringify(ctx)).not.toContain('PROPOSAL BODY');
    expect(buildRunContext(iter2Run({ process: 'bogus' as any }, { kind: 'bogus' as any }))).toMatchObject({ issue: { process: 'direct', designApprovedAt: null }, agent: { kind: 'coder' } });
  });

  it('finds the workDir from the env or by walking up from cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ncp-find-'));
    writeRunContext(dir, claimedRun());
    const nested = join(dir, 'repo', 'src');
    mkdirSync(nested, { recursive: true });
    expect(findWorkDir({}, nested)).toBe(dir);
    expect(findWorkDir({ NOCOPROJECT_WORKDIR: '/elsewhere' }, nested)).toBe('/elsewhere');
    expect(findWorkDir({}, tmpdir())).toBeNull();
  });

  it('reads checkout.json back into complete/fail extras', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ncp-co-'));
    expect(checkoutExtras(dir)).toEqual({});
    writeCheckoutRecord(dir, { url: 'https://x/y.git', ref: 'main', branchName: 'agent/a/np-1', path: join(dir, 'y') });
    expect(checkoutExtras(dir)).toEqual({ branchName: 'agent/a/np-1', repoUrl: 'https://x/y.git' });
    writeFileSync(join(dir, '.nocoproject', 'checkout.json'), '{"url":""}');
    expect(readCheckoutRecord(dir)).toBeNull();
  });

  it('injects NOCOPROJECT_WORKDIR and NOCOPROJECT_HOME into the agent env', () => {
    const env = buildAgentEnv({ serverUrl: 'http://s/main', token: 'npr_x', claimed: claimedRun(), workDir: '/w', home: '/h' });
    expect(env).toMatchObject({ NOCOPROJECT_WORKDIR: '/w', NOCOPROJECT_HOME: '/h', NOCOPROJECT_ISSUE_KEY: 'NP-12' });
    expect(env.NOCOPROJECT_API_KEY).toBeUndefined();
  });

  it('injects the agent env but skips reserved and invalid names', () => {
    expect(filterAgentEnv({ A_B: '1', PATH: '/x', HOME: '/h', SHELL: '/bin/sh', NOCOPROJECT_X: 'y', 'bad-name': 'z', lower: 'q' })).toEqual({
      vars: { A_B: '1' },
      skipped: ['PATH', 'HOME', 'SHELL', 'NOCOPROJECT_X', 'bad-name', 'lower'],
    });
    const run = iter2Run();
    const env = buildAgentEnv({ serverUrl: 'http://s/main', token: 'npr_real', claimed: run, workDir: '/w' });
    expect(env.DEPLOY_TOKEN).toBe('deploy-secret-value-123');
    expect(env.NOCOPROJECT_TOKEN).toBe('npr_real');
    expect(env.PATH).not.toBe('/evil');
  });
});
