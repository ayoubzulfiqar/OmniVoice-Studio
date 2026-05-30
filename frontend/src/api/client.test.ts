import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('apiFetch PIN header', () => {
  let realFetch;
  beforeEach(() => { realFetch = global.fetch; sessionStorage.clear(); });
  afterEach(() => { global.fetch = realFetch; sessionStorage.clear(); });

  it('attaches X-OmniVoice-Pin when present in sessionStorage', async () => {
    sessionStorage.setItem('ov_pin', '424242');
    const seen: any = {};
    global.fetch = vi.fn((_url, opts) => { Object.assign(seen, opts); return Promise.resolve({ ok: true, json: async () => ({}) }); });
    const { apiFetch } = await import('./client');
    await apiFetch('/system/info');
    expect((seen.headers || {})['X-OmniVoice-Pin']).toBe('424242');
  });

  it('omits the header when no pin', async () => {
    const seen: any = {};
    global.fetch = vi.fn((_url, opts) => { Object.assign(seen, opts); return Promise.resolve({ ok: true, json: async () => ({}) }); });
    const { apiFetch } = await import('./client');
    await apiFetch('/system/info');
    expect((seen.headers || {})['X-OmniVoice-Pin']).toBeUndefined();
  });
});
