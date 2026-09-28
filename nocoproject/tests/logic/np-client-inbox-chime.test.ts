// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ChimeModule = typeof import('../../client/pages/np/inbox/inbox-chime.js');

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: 'suspended' | 'running' = 'suspended';
  currentTime = 0;
  destination = {};
  oscillators = 0;
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  createOscillator() {
    this.oscillators += 1;
    return {
      type: '',
      frequency: { setValueAtTime: vi.fn() },
      connect: (node: unknown) => node,
      start: vi.fn(),
      stop: vi.fn(),
    };
  }
  createGain() {
    return {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: (node: unknown) => node,
    };
  }
}

async function load(): Promise<ChimeModule> {
  vi.resetModules();
  return import('../../client/pages/np/inbox/inbox-chime.js');
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  FakeAudioContext.instances = [];
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('inbox chime', () => {
  it('stays silent until a user gesture unlocks audio, then rings two notes', async () => {
    const chime = await load();
    chime.playInboxChime();
    expect(FakeAudioContext.instances).toHaveLength(0);

    chime.armInboxChime();
    window.dispatchEvent(new Event('pointerdown'));
    await flush();
    const [ctx] = FakeAudioContext.instances;
    expect(ctx?.state).toBe('running');

    chime.playInboxChime();
    await flush();
    expect(ctx?.oscillators).toBe(2);
  });

  it('rings in only one tab while the Web Lock is held', async () => {
    const held = new Set<string>();
    const request = vi.fn(
      async (
        name: string,
        _options: unknown,
        callback: (lock: object | null) => Promise<unknown>,
      ) => {
        if (held.has(name)) return callback(null);
        held.add(name);
        try {
          return await callback({});
        } finally {
          held.delete(name);
        }
      },
    );
    vi.stubGlobal('navigator', { ...navigator, locks: { request } });
    vi.useFakeTimers();
    try {
      const chime = await load();
      chime.playInboxChime({ preview: true });
      await vi.advanceTimersByTimeAsync(0);
      const [ctx] = FakeAudioContext.instances;
      expect(ctx?.oscillators).toBe(2);

      chime.playInboxChime();
      chime.playInboxChime();
      await vi.advanceTimersByTimeAsync(0);
      expect(ctx?.oscillators).toBe(4);

      await vi.advanceTimersByTimeAsync(3000);
      chime.playInboxChime();
      await vi.advanceTimersByTimeAsync(0);
      expect(ctx?.oscillators).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });
});
