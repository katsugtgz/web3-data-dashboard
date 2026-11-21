import { useCallback, useEffect, useState } from 'react';
import type { AgentProfile } from '../../shared/types';

export const AGENT_PROFILE_KEY = 'radar.agentProfile.v1';

export const DEFAULT_AGENT_PROFILE: AgentProfile = {
  agent: 'hermes',
  agentNote: '',
  host: 'local-pc',
  os: 'macos',
  specs: '4 vCPU / 8 GB / no GPU',
  browserMode: 'headed',
  residentialIp: true,
  wallet: 'burner-extension',
  walletNote: 'Burner wallet only, strict per-task cap',
  budgetUsd: 10,
  maxMinutes: 30,
  language: 'en',
};

const VALID_AGENTS = new Set(['hermes', 'openclaw', 'claude-computer-use', 'browser-use', 'other']);
const VALID_HOSTS = new Set(['local-pc', 'vps', 'cloud-vm']);
const VALID_OS = new Set(['windows', 'macos', 'linux']);
const VALID_MODES = new Set(['headless', 'headed', 'computer-use']);
const VALID_WALLETS = new Set(['browser-extension', 'hardware', 'burner-extension', 'none']);

function normalizeProfile(raw: unknown): AgentProfile {
  if (!raw || typeof raw !== 'object') return DEFAULT_AGENT_PROFILE;
  const obj = raw as Record<string, unknown>;
  return {
    agent: typeof obj.agent === 'string' && VALID_AGENTS.has(obj.agent)
      ? (obj.agent as AgentProfile['agent'])
      : DEFAULT_AGENT_PROFILE.agent,
    agentNote: typeof obj.agentNote === 'string' ? obj.agentNote.slice(0, 120) : '',
    host: typeof obj.host === 'string' && VALID_HOSTS.has(obj.host)
      ? (obj.host as AgentProfile['host'])
      : DEFAULT_AGENT_PROFILE.host,
    os: typeof obj.os === 'string' && VALID_OS.has(obj.os)
      ? (obj.os as AgentProfile['os'])
      : DEFAULT_AGENT_PROFILE.os,
    specs: typeof obj.specs === 'string' ? obj.specs.slice(0, 120) : DEFAULT_AGENT_PROFILE.specs,
    browserMode: typeof obj.browserMode === 'string' && VALID_MODES.has(obj.browserMode)
      ? (obj.browserMode as AgentProfile['browserMode'])
      : DEFAULT_AGENT_PROFILE.browserMode,
    residentialIp: typeof obj.residentialIp === 'boolean' ? obj.residentialIp : DEFAULT_AGENT_PROFILE.residentialIp,
    wallet: typeof obj.wallet === 'string' && VALID_WALLETS.has(obj.wallet)
      ? (obj.wallet as AgentProfile['wallet'])
      : DEFAULT_AGENT_PROFILE.wallet,
    walletNote: typeof obj.walletNote === 'string' ? obj.walletNote.slice(0, 140) : DEFAULT_AGENT_PROFILE.walletNote,
    budgetUsd:
      typeof obj.budgetUsd === 'number' && Number.isFinite(obj.budgetUsd) && obj.budgetUsd >= 0
        ? Math.min(10_000, obj.budgetUsd)
        : DEFAULT_AGENT_PROFILE.budgetUsd,
    maxMinutes:
      typeof obj.maxMinutes === 'number' && Number.isFinite(obj.maxMinutes) && obj.maxMinutes >= 1
        ? Math.min(480, Math.round(obj.maxMinutes))
        : DEFAULT_AGENT_PROFILE.maxMinutes,
    language: 'en',
  };
}

function readStoredProfile(): { profile: AgentProfile; hasConfigured: boolean } {
  try {
    const raw = localStorage.getItem(AGENT_PROFILE_KEY);
    if (!raw) return { profile: DEFAULT_AGENT_PROFILE, hasConfigured: false };
    return { profile: normalizeProfile(JSON.parse(raw)), hasConfigured: true };
  } catch {
    return { profile: DEFAULT_AGENT_PROFILE, hasConfigured: false };
  }
}

export function useAgentProfile() {
  const [state, setState] = useState<{ profile: AgentProfile; hasConfigured: boolean }>(() => readStoredProfile());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === AGENT_PROFILE_KEY || e.key === null) {
        setState(readStoredProfile());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const saveProfile = useCallback((next: AgentProfile) => {
    const normalized = normalizeProfile(next);
    try {
      localStorage.setItem(AGENT_PROFILE_KEY, JSON.stringify(normalized));
    } catch {
      // Ignore storage quota errors while updating in-memory state
    }
    setState({ profile: normalized, hasConfigured: true });
    return normalized;
  }, []);

  return {
    profile: state.profile,
    hasConfigured: state.hasConfigured,
    saveProfile,
  };
}
