import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import type { AgentProfile } from '../../shared/types';

function useBackdropDismiss(ref: RefObject<HTMLDialogElement | null>) {
  useEffect(() => {
    const dlg = ref.current;
    if (!dlg || 'closedBy' in HTMLDialogElement.prototype) return;
    let mouseDownOnBackdrop = false;
    const isOnBackdrop = (event: MouseEvent): boolean => {
      if (event.target !== dlg) return false;
      const rect = dlg.getBoundingClientRect();
      return !(
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width
      );
    };
    const onMouseDown = (event: MouseEvent) => {
      mouseDownOnBackdrop = isOnBackdrop(event);
    };
    const onClick = (event: MouseEvent) => {
      const shouldClose = mouseDownOnBackdrop && isOnBackdrop(event);
      mouseDownOnBackdrop = false;
      if (shouldClose) dlg.close();
    };
    dlg.addEventListener('mousedown', onMouseDown);
    dlg.addEventListener('click', onClick);
    return () => {
      dlg.removeEventListener('mousedown', onMouseDown);
      dlg.removeEventListener('click', onClick);
    };
  }, [ref]);
}

interface FormProps {
  initialProfile: AgentProfile;
  onSave: (next: AgentProfile) => void;
  onClose: () => void;
}

function AgentProfileForm({ initialProfile, onSave, onClose }: FormProps) {
  const [form, setForm] = useState<AgentProfile>(initialProfile);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSave(form);
    onClose();
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

      <div className="profile-grid">
        <label className="field">
          <span>Agent</span>
          <select
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

        <label className="field">
          <span>Agent / model note (optional)</span>
          <input
            type="text"
            placeholder="e.g. Claude Sonnet / Qwen 32B"
            value={form.agentNote ?? ''}
            onChange={e => setForm({ ...form, agentNote: e.target.value })}
          />
        </label>

        <label className="field">
          <span>Host</span>
          <select
            className="select"
            value={form.host}
            onChange={e => setForm({ ...form, host: e.target.value as AgentProfile['host'] })}
          >
            <option value="local-pc">Local PC</option>
            <option value="vps">VPS</option>
            <option value="cloud-vm">Cloud VM</option>
          </select>
        </label>

        <label className="field">
          <span>OS</span>
          <select
            className="select"
            value={form.os}
            onChange={e => setForm({ ...form, os: e.target.value as AgentProfile['os'] })}
          >
            <option value="macos">macOS</option>
            <option value="linux">Linux</option>
            <option value="windows">Windows</option>
          </select>
        </label>

        <label className="field">
          <span>Specs</span>
          <input
            type="text"
            placeholder="4 vCPU / 8 GB / no GPU"
            value={form.specs ?? ''}
            onChange={e => setForm({ ...form, specs: e.target.value })}
          />
        </label>

        <label className="field">
          <span>Browser mode</span>
          <select
            className="select"
            value={form.browserMode}
            onChange={e => setForm({ ...form, browserMode: e.target.value as AgentProfile['browserMode'] })}
          >
            <option value="headed">Headed browser</option>
            <option value="headless">Headless browser</option>
            <option value="computer-use">Desktop computer-use</option>
          </select>
        </label>

        <label className="field">
          <span>Wallet policy</span>
          <select
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

        <label className="field">
          <span>Wallet note (optional)</span>
          <input
            type="text"
            placeholder="e.g. Rabby burner, max $20"
            value={form.walletNote ?? ''}
            onChange={e => setForm({ ...form, walletNote: e.target.value })}
          />
        </label>

        <label className="field">
          <span>Per-task budget cap (USD)</span>
          <input
            type="number"
            min={0}
            max={10000}
            value={form.budgetUsd}
            onChange={e => setForm({ ...form, budgetUsd: Math.max(0, Number(e.target.value) || 0) })}
          />
        </label>

        <label className="field">
          <span>Time cap (minutes)</span>
          <input
            type="number"
            min={1}
            max={480}
            value={form.maxMinutes}
            onChange={e => setForm({ ...form, maxMinutes: Math.max(1, Number(e.target.value) || 30) })}
          />
        </label>
      </div>

      <label className="check-row">
        <input
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
}

export function AgentProfileDialog({ open, profile, onSave, onClose }: Props) {
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
        />
      )}
    </dialog>
  );
}
