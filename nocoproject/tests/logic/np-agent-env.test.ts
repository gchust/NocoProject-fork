// @vitest-environment node
/**
 * Agent environment variables (iteration-2 contract §B, §G): AES-GCM round trip and key resolution (pure), name
 * and size rules, who may list / set / reveal / audit, ciphertext at rest, audits, and the decrypted values in the
 * daemon's claim payload only (never in browser responses). Real PostgreSQL for the service parts.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { validateEnvName } from '../../server/modules/agent/env.service.ts';
import type { NpServices } from '../../server/modules/services.ts';
import {
  createSecretBox,
  resolveSecretKey,
  SecretKeyError,
} from '../../server/modules/shared/crypto.ts';
import {
  ALICE,
  BOB,
  CAROL,
  buildServices,
  claimOne,
  createAgent,
  openNpTestDatabase,
  registerRuntime,
  resetData,
  rows,
  setRole,
  TEST_SECRET_KEY,
  type Fixture,
  type NpTestDatabase,
} from './np-harness.ts';

describe('secret box (pure)', () => {
  it('round-trips with AES-256-GCM in the v1 format and refuses another key or a tampered text', () => {
    const box = createSecretBox(TEST_SECRET_KEY);
    const sealed = box.encrypt('héllo wörld');
    expect(sealed).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/u);
    expect(sealed).not.toContain('héllo');
    expect(box.decrypt(sealed)).toBe('héllo wörld');
    expect(box.encrypt('x')).not.toBe(box.encrypt('x'));
    expect(() =>
      createSecretBox(Buffer.alloc(32, 2)).decrypt(sealed),
    ).toThrow();
    const parts = sealed.split(':');
    expect(() =>
      box.decrypt(
        [
          parts[0],
          parts[1],
          parts[2],
          Buffer.from('zz').toString('base64'),
        ].join(':'),
      ),
    ).toThrow();
    expect(() => box.decrypt('v2:a:b:c')).toThrow(SecretKeyError);
  });

  it('resolves the key from hex, base64 or the auth secret (with a warning)', () => {
    const warnings: string[] = [];
    const hex = 'ab'.repeat(32);
    expect(resolveSecretKey({ secretKey: hex }).toString('hex')).toBe(hex);
    const b64 = Buffer.alloc(32, 7).toString('base64');
    expect(resolveSecretKey({ secretKey: b64 })).toEqual(Buffer.alloc(32, 7));
    expect(() => resolveSecretKey({ secretKey: 'short' })).toThrow(
      SecretKeyError,
    );
    const derived = resolveSecretKey({ authSecret: 'auth' }, (message) =>
      warnings.push(message),
    );
    expect(derived).toHaveLength(32);
    expect(resolveSecretKey({ authSecret: 'auth' })).toEqual(derived);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('NOCOPROJECT_SECRET_KEY');
    expect(warnings[0]).not.toContain('auth:');
  });

  it('accepts only legal, non-reserved names', () => {
    expect(validateEnvName('API_TOKEN')).toBe('API_TOKEN');
    expect(validateEnvName('_X1')).toBe('_X1');
    for (const bad of ['lower', '1ABC', 'A-B', '', 'A'.repeat(129)])
      expect(() => validateEnvName(bad)).toThrow(
        expect.objectContaining({ code: 'INVALID_ENV_NAME' }),
      );
    for (const reserved of [
      'PATH',
      'HOME',
      'SHELL',
      'NOCOPROJECT_TOKEN',
      'NOCOPROJECT_',
    ])
      expect(() => validateEnvName(reserved)).toThrow(
        expect.objectContaining({ code: 'RESERVED_ENV_NAME' }),
      );
  });
});

const opened = await openNpTestDatabase('np_t_agent_env');
const skip = 'skip' in opened ? opened.skip : null;
if (skip) console.warn(`[np-agent-env] skipped: ${skip}`);
const db = (skip ? null : opened) as NpTestDatabase | null;

afterAll(async () => {
  await db?.close();
});

let services: NpServices;
let fixture: Fixture;
let agentId: string;

beforeEach(async () => {
  if (!db) return;
  await resetData(db);
  services = buildServices(db.database).services;
  await setRole(db, ALICE, 'owner');
  await setRole(db, BOB, 'member');
  await setRole(db, CAROL, 'member');
  fixture = await registerRuntime(services, BOB);
  agentId = await createAgent(services, BOB, fixture.runtimeId, 'Dev');
});

describe.skipIf(!db)('agent environment variables (PostgreSQL)', () => {
  it('lets the agent owner set and list names only; values are stored encrypted', async () => {
    const listed = await services.agentEnv.put(BOB, agentId, [
      { name: 'API_TOKEN', value: 'sk-live-123456' },
      { name: 'REGION', value: 'eu' },
    ]);
    expect(listed.map((item) => [item.name, item.updatedByName])).toEqual([
      ['API_TOKEN', 'Bob'],
      ['REGION', 'Bob'],
    ]);
    expect(JSON.stringify(listed)).not.toContain('sk-live');
    const stored = await rows(db!, 'agent_env_vars');
    expect(
      stored.map((row) => String(row.value_encrypted).startsWith('v1:')),
    ).toEqual([true, true]);
    expect(JSON.stringify(stored)).not.toContain('sk-live');
    await services.agentEnv.put(BOB, agentId, [
      { name: 'REGION', value: 'us' },
    ]);
    expect(await services.agentEnv.list(ALICE, agentId)).toHaveLength(2);
    await expect(services.agentEnv.list(CAROL, agentId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      services.agentEnv.put(CAROL, agentId, [{ name: 'X', value: '1' }]),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      services.agentEnv.put(BOB, agentId, [{ name: 'PATH', value: '/x' }]),
    ).rejects.toMatchObject({
      code: 'RESERVED_ENV_NAME',
    });
    await expect(
      services.agentEnv.put(BOB, agentId, [
        { name: 'BIG', value: 'x'.repeat(8 * 1024 + 1) },
      ]),
    ).rejects.toMatchObject({ code: 'INVALID_ENV_VALUE' });
    await expect(services.agentEnv.list(BOB, 'missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('reveals values to owner/admin only and audits set, delete and reveal', async () => {
    await services.agentEnv.put(BOB, agentId, [
      { name: 'API_TOKEN', value: 'sk-live-123456' },
    ]);
    await expect(services.agentEnv.reveal(BOB, agentId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(services.agentEnv.audits(BOB, agentId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await services.agentEnv.reveal(ALICE, agentId)).toEqual([
      { name: 'API_TOKEN', value: 'sk-live-123456' },
    ]);
    await services.agentEnv.remove(BOB, agentId, 'API_TOKEN');
    await expect(
      services.agentEnv.remove(BOB, agentId, 'API_TOKEN'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const audits = await services.agentEnv.audits(ALICE, agentId);
    expect(
      audits.map((item) => [item.action, item.names, item.userName]),
    ).toEqual([
      ['delete', ['API_TOKEN'], 'Bob'],
      ['reveal', ['API_TOKEN'], 'Alice'],
      ['set', ['API_TOKEN'], 'Bob'],
    ]);
  });

  it('puts the decrypted variables in the claim payload and nowhere in the browser agent view', async () => {
    await services.agentEnv.put(BOB, agentId, [
      { name: 'API_TOKEN', value: 'sk-live-123456' },
      { name: 'REGION', value: 'eu' },
    ]);
    await services.issues.create(BOB, {
      title: 'Work',
      executor: { type: 'agent', id: agentId },
    });
    const claimed = await claimOne(services, BOB, fixture);
    expect(claimed?.agent.env).toEqual({
      API_TOKEN: 'sk-live-123456',
      REGION: 'eu',
    });
    const agentView = await services.agents.get(BOB, agentId);
    expect(JSON.stringify(agentView)).not.toContain('sk-live');
    expect(agentView).not.toHaveProperty('env');
  });
});
