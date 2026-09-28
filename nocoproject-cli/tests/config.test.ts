import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configPath, loadConfig, loadDaemonSettings, normalizeServerUrl, readStoredConfig, writeStoredConfig } from '../src/config.js';
import { parseDuration } from '../src/util/duration.js';

describe('config', () => {
  it('writes the config with 0600 and the home with 0700', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'ncp-cfg-')), 'home');
    writeStoredConfig({ serverUrl: 'http://x/main', apiKey: 'secret-key-123' }, home);
    expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it('generates a stable daemonId once', () => {
    const home = mkdtempSync(join(tmpdir(), 'ncp-cfg-'));
    const env = { NOCOPROJECT_HOME: home };
    const a = loadConfig(env);
    const b = loadConfig(env);
    expect(a.daemonId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.daemonId).toBe(a.daemonId);
    expect(readStoredConfig(home).daemonId).toBe(a.daemonId);
    expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
  });

  it('applies env overrides', () => {
    const home = mkdtempSync(join(tmpdir(), 'ncp-cfg-'));
    writeStoredConfig({ serverUrl: 'http://stored/main', apiKey: 'stored-key-1234', deviceName: 'box' }, home);
    const cfg = loadConfig({ NOCOPROJECT_HOME: home, NOCOPROJECT_SERVER_URL: 'http://env:1/app/', NOCOPROJECT_API_KEY: 'env-key-12345', NOCOPROJECT_DEVICE_NAME: 'laptop' });
    expect(cfg).toMatchObject({ serverUrl: 'http://env:1/app', apiKey: 'env-key-12345', deviceName: 'laptop' });
  });

  it('normalizes and validates server urls', () => {
    expect(normalizeServerUrl('http://127.0.0.1:13000/main/')).toBe('http://127.0.0.1:13000/main');
    expect(normalizeServerUrl('https://a.example.com')).toBe('https://a.example.com');
    expect(() => normalizeServerUrl('ftp://x')).toThrow();
    expect(() => normalizeServerUrl('http://u:p@x/main')).toThrow();
  });

  it('resolves daemon settings', () => {
    const s = loadDaemonSettings('/h', { NOCOPROJECT_AGENT_IDLE_WATCHDOG: '30m', NOCOPROJECT_MAX_CONCURRENT: '4', NOCOPROJECT_PROVIDERS: 'echo, opencode' });
    expect(s).toMatchObject({ idleWatchdogMs: 1_800_000, maxConcurrent: 4, providers: ['echo', 'opencode'], workspacesRoot: '/h/workspaces' });
    expect(loadDaemonSettings('/h', {}).maxConcurrent).toBe(20);
    expect(loadDaemonSettings('/h', {}).idleWatchdogMs).toBe(7_200_000);
  });

  it('parses durations', () => {
    expect(parseDuration('2h', 0)).toBe(7_200_000);
    expect(parseDuration('1h30m', 0)).toBe(5_400_000);
    expect(parseDuration('1500ms', 0)).toBe(1500);
    expect(parseDuration('90', 0)).toBe(90_000);
    expect(parseDuration('0', 5)).toBe(0);
    expect(parseDuration('bogus', 5)).toBe(5);
  });
});
