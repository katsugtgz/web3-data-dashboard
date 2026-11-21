import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AgentProfile } from '../../shared/types';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import { CopyStatusBanner, type CopyStatus } from './CopyStatusBanner';

interface FormProps {
  initialProfile: AgentProfile;
  onSave: (next: AgentProfile) => void;
  onClose: () => void;
  copyStatus: CopyStatus | null;
  pendingCopyName: string | null;
  onCopyPending: () => void;
}

function AgentProfileForm({ initialProfile, onSave, onClose, copyStatus, pendingCopyName, onCopyPending }: FormProps) {
  const [form, setForm] = useState<AgentProfile>(initialProfile);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    // Save only; App owns close timing — during a pending copy the dialog
    // stays up until the copy outcome is shown inside it.
    onSave(form);
  };

  return (
    <form className="dlg-inner profile-form" onSubmit={handleSubmit}>
      <div className="dlg-head">
        <div>
          <h2 id="agent-profile-title">Agent Environment Profile</h2>
          <p className="note">Included in every copied agent brief so prompts match your local/VPS setup.</p>
        </div>
        <button type="button" className="dlg-x" onClick={onClose} aria-label="Close agent profile dialog">
          ×
        </button>
      </div>

      <p className="privacy-banner">
        Stored locally in your browser only. Never enter seed phrases, private keys, passwords, or cookies.
      </p>

      {copyStatus && <CopyStatusBanner status={copyStatus} />}

      {pendingCopyName && !copyStatus && (
        <p className="privacy-banner">
          Will copy the agent brief for <strong>{pendingCopyName}</strong> right after you save. Set up your
          environment below, then press “Save profile”.
          <button type="button" className="chip" style={{ marginLeft: 8 }} onClick={onCopyPending}>
            Copy now without saving
          </button>
        </p>
      )}

      <div className="profile-grid">
        <label className="field" htmlFor="profile-agent">
          <span>Agent</span>
          <select
            id="profile-agent"
            className="select"
            value={form.agent}
            onChange={e => setForm({ ...form, agent: e.target.value as AgentProfile['agent'] })}
          >
            <option value="hermes">Hermes</option>
            <option value="openclaw">OpenClaw</option>
            <option value="claude-computer-use">Claude computer-use</option>
            <option value="browser-use">browser-use</option>
            <option value="other">Other</option>
          </select>
        </label>

        <label className="field" htmlFor="profile-agent-note">
          <span>Agent / model note (optional)</span>
          <input
            id="profile-agent-note"
            type="text"
            placeholder="e.g. Claude Sonnet / Qwen 32B"
            value={form.agentNote ?? ''}
            onChange={e => setForm({ ...form, agentNote: e.target.value })}
          />
        </label>

        <label className="field" htmlFor="profile-host">
          <span>Host</span>
          <select
            id="profile-host"
            className="select"
            value={form.host}
            onChange={e => setForm({ ...form, host: e.target.value as AgentProfile['host'] })}
          >
            <option value="local-pc">Local PC</option>
            <option value="vps">VPS</option>
            <option value="cloud-vm">Cloud VM</option>
          </select>
        </label>

        <label className="field" htmlFor="profile-os">
          <span>OS</span>
          <select
            id="profile-os"
            className="select"
            value={form.os}
            onChange={e => setForm({ ...form, os: e.target.value as AgentProfile['os'] })}
          >
            <option value="macos">macOS</option>
            <option value="linux">Linux</option>
            <option value="windows">Windows</option>
          </select>
        </label>

        <label className="field" htmlFor="profile-specs">
          <span>Specs</span>
          <input
            id="profile-specs"
            type="text"
            placeholder="4 vCPU / 8 GB / no GPU"
            value={form.specs ?? ''}
            onChange={e => setForm({ ...form, specs: e.target.value })}
          />
        </label>

        <label className="field" htmlFor="profile-browser-mode">
          <span>Browser mode</span>
          <select
            id="profile-browser-mode"
            className="select"
            value={form.browserMode}
            onChange={e => setForm({ ...form, browserMode: e.target.value as AgentProfile['browserMode'] })}
          >
            <option value="headed">Headed browser</option>
            <option value="headless">Headless browser</option>
            <option value="computer-use">Desktop computer-use</option>
          </select>
        </label>

        <label className="field" htmlFor="profile-wallet">
          <span>Wallet policy</span>
          <select
            id="profile-wallet"
            className="select"
            value={form.wallet}
            onChange={e => setForm({ ...form, wallet: e.target.value as AgentProfile['wallet'] })}
          >
            <option value="burner-extension">Burner extension</option>
            <option value="browser-extension">Browser extension</option>
            <option value="hardware">Hardware wallet</option>
            <option value="none">None (read-only / forms)</option>
          </select>
        </label>

        <label className="field" htmlFor="profile-wallet-note">
          <span>Wallet note (optional)</span>
          <input
            id="profile-wallet-note"
            type="text"
            placeholder="e.g. Rabby burner, max $20"
            value={form.walletNote ?? ''}
            onChange={e => setForm({ ...form, walletNote: e.target.value })}
          />
        </label>

        <label className="field" htmlFor="profile-budget">
          <span>Per-task budget cap (USD)</span>
          <input
            id="profile-budget"
            type="number"
            min={0}
            max={10000}
            value={form.budgetUsd}
            onChange={e => setForm({ ...form, budgetUsd: Math.max(0, Number(e.target.value) || 0) })}
          />
        </label>

        <label className="field" htmlFor="profile-time-cap">
          <span>Time cap (minutes)</span>
          <input
            id="profile-time-cap"
            type="number"
            min={1}
            max={480}
            value={form.maxMinutes}
            onChange={e => setForm({ ...form, maxMinutes: Math.max(1, Number(e.target.value) || 30) })}
          />
        </label>
      </div>

      <label className="check-row" htmlFor="profile-residential-ip">
        <input
          id="profile-residential-ip"
          type="checkbox"
          checked={form.residentialIp}
          onChange={e => setForm({ ...form, residentialIp: e.target.checked })}
        />
        <span>Running on residential IP</span>
      </label>

      <div className="dlg-actions-bar">
        <button type="button" className="btn btn-subtle" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn">
          Save profile
        </button>
      </div>
    </form>
  );
}

interface Props {
  open: boolean;
  profile: AgentProfile;
  onSave: (next: AgentProfile) => void;
  onClose: () => void;
  copyStatus: CopyStatus | null;
  /** Pending first-copy target: its project name, or null when opened plain. */
  pendingCopyName: string | null;
  onCopyPending: () => void;
}

export function AgentProfileDialog({
  open,
  profile,
  onSave,
  onClose,
  copyStatus,
  pendingCopyName,
  onCopyPending,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    if (!open && dlg.open) dlg.close();
  }, [open]);

  useBackdropDismiss(ref);

  return (
    <dialog
      id="agent-profile-dialog"
      ref={ref}
      aria-labelledby="agent-profile-title"
      onClose={onClose}
      {...({ closedby: 'any' } as Record<string, string>)}
    >
      {open && (
        <AgentProfileForm
          key={JSON.stringify(profile)}
          initialProfile={profile}
          onSave={onSave}
          onClose={() => ref.current?.close()}
          copyStatus={copyStatus}
          pendingCopyName={pendingCopyName}
          onCopyPending={onCopyPending}
        />
      )}
    </dialog>
  );
}
