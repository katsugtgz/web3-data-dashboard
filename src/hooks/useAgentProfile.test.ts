import { describe, expect, test } from 'bun:test';
import { AGENT_PROFILE_KEY, DEFAULT_AGENT_PROFILE, storedProfileFromRaw } from './useAgentProfile';

describe('storedProfileFromRaw (useAgentProfile storage seam)', () => {
  test('null/invalid JSON keeps defaults and does not count as configured', () => {
    expect(storedProfileFromRaw(null)).toEqual({ profile: DEFAULT_AGENT_PROFILE, hasConfigured: false });
    expect(storedProfileFromRaw('null')).toEqual({ profile: DEFAULT_AGENT_PROFILE, hasConfigured: false });
    expect(storedProfileFromRaw('42')).toEqual({ profile: DEFAULT_AGENT_PROFILE, hasConfigured: false });
    expect(storedProfileFromRaw('"str"')).toEqual({ profile: DEFAULT_AGENT_PROFILE, hasConfigured: false });
    expect(storedProfileFromRaw('{oops')).toEqual({ profile: DEFAULT_AGENT_PROFILE, hasConfigured: false });
  });

  test('parsed object counts as configured and normalizes fields', () => {
    const stored = { ...DEFAULT_AGENT_PROFILE, budgetUsd: 25, agent: 'nope' };
    const res = storedProfileFromRaw(JSON.stringify(stored));
    expect(res.hasConfigured).toBe(true);
    expect(res.profile.budgetUsd).toBe(25);
    expect(res.profile.agent).toBe(DEFAULT_AGENT_PROFILE.agent); // invalid value → default
  });

  test('storage key unchanged', () => {
    expect(AGENT_PROFILE_KEY).toBe('radar.agentProfile.v1');
  });
});
