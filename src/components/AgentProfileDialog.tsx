import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AgentProfile } from '../../shared/types';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import { CopyStatusBanner, type CopyStatus } from './CopyStatusBanner';
import { BotIcon, CopyIcon, ShieldCheckIcon, XIcon } from './Icons';

interface SectionFieldsProps {
  form: AgentProfile;
  onUpdate: (patch: Partial<AgentProfile>) => void;
}

function EnvironmentSection({ form, onUpdate }: SectionFieldsProps) {
  return (
    <section className="profile-section" aria-labelledby="profile-section-env">
      <h3 id="profile-section-env" className="profile-section-title">
        Agent &amp; Environment
      </h3>
      <div className="profile-grid">
        <label className="field" htmlFor="profile-agent">
          <span>Agent</span>
          <select
            id="profile-agent"
            className="select"
            value={form.agent}
            onChange={e => onUpdate({ agent: e.target.value as AgentProfile['agent'] })}
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
            onChange={e => onUpdate({ agentNote: e.target.value })}
          />
        </label>

        <label className="field" htmlFor="profile-host">
          <span>Host</span>
          <select
            id="profile-host"
            className="select"
            value={form.host}
            onChange={e => onUpdate({ host: e.target.value as AgentProfile['host'] })}
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
            onChange={e => onUpdate({ os: e.target.value as AgentProfile['os'] })}
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
            onChange={e => onUpdate({ specs: e.target.value })}
          />
        </label>

        <label className="field" htmlFor="profile-browser-mode">
          <span>Browser mode</span>
          <select
            id="profile-browser-mode"
            className="select"
            value={form.browserMode}
            onChange={e => onUpdate({ browserMode: e.target.value as AgentProfile['browserMode'] })}
          >
            <option value="headed">Headed browser</option>
            <option value="headless">Headless browser</option>
            <option value="computer-use">Desktop computer-use</option>
          </select>
        </label>
      </div>
    </section>
  );
}

interface GuardrailsSectionProps extends SectionFieldsProps {
  budgetText: string;
  timeCap: string;
  onBudgetChange: (value: string) => void;
  onBudgetBlur: () => void;
  onTimeCapChange: (value: string) => void;
}

function GuardrailsSection({
  form,
  budgetText,
  timeCap,
  onUpdate,
  onBudgetChange,
  onBudgetBlur,
  onTimeCapChange,
}: GuardrailsSectionProps) {
  return (
    <section className="profile-section" aria-labelledby="profile-section-guardrails">
      <h3 id="profile-section-guardrails" className="profile-section-title">
        Wallet &amp; Guardrails
      </h3>
      <div className="profile-grid">
        <label className="field" htmlFor="profile-wallet">
          <span>Wallet policy</span>
          <select
            id="profile-wallet"
            className="select"
            value={form.wallet}
            onChange={e => onUpdate({ wallet: e.target.value as AgentProfile['wallet'] })}
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
            onChange={e => onUpdate({ walletNote: e.target.value })}
          />
        </label>

        <label className="field" htmlFor="profile-budget">
          <span>Per-task budget cap (USD)</span>
          <span className="input-adorned">
            <span className="input-affix input-prefix mono" aria-hidden="true">
              $
            </span>
            <input
              id="profile-budget"
              type="number"
              min={0}
              max={10000}
              step="any"
              value={budgetText}
              onChange={e => onBudgetChange(e.target.value)}
              onBlur={onBudgetBlur}
            />
          </span>
        </label>

        <label className="field" htmlFor="profile-time-cap">
          <span>Time cap (minutes)</span>
          <span className="input-adorned">
            <input
              id="profile-time-cap"
              type="number"
              min={1}
              max={480}
              required
              value={timeCap}
              onChange={e => onTimeCapChange(e.target.value)}
            />
            <span className="input-affix input-suffix mono" aria-hidden="true">
              min
            </span>
          </span>
        </label>
      </div>

      <label className="check-row profile-check-row" htmlFor="profile-residential-ip">
        <input
          id="profile-residential-ip"
          type="checkbox"
          checked={form.residentialIp}
          onChange={e => onUpdate({ residentialIp: e.target.checked })}
        />
        <span>Running on residential IP</span>
      </label>
    </section>
  );
}

interface FormProps {
  initialProfile: AgentProfile;
  onSave: (next: AgentProfile) => void;
  onClose: () => void;
  copyStatus: CopyStatus | null;
  pendingCopyName: string | null;
  onCopyPending: () => void;
}

function AgentProfileForm({
  initialProfile,
  onSave,
  onClose,
  copyStatus,
  pendingCopyName,
  onCopyPending,
}: FormProps) {
  const [form, setForm] = useState<AgentProfile>(initialProfile);
  const [budgetText, setBudgetText] = useState(String(initialProfile.budgetUsd));
  const [timeCap, setTimeCap] = useState(String(initialProfile.maxMinutes));

  const updateForm = (patch: Partial<AgentProfile>) => setForm(prev => ({ ...prev, ...patch }));

  const parseBudget = (raw: string): number => {
    const trimmed = raw.trim();
    if (!trimmed) return initialProfile.budgetUsd;
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 ? Math.min(10_000, n) : initialProfile.budgetUsd;
  };

  const handleBudgetBlur = () => {
    const trimmed = budgetText.trim();
    if (!trimmed) return;
    const nextBudget = parseBudget(trimmed);
    setForm(prev => ({ ...prev, budgetUsd: nextBudget }));
    setBudgetText(String(nextBudget));
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSave({ ...form, budgetUsd: parseBudget(budgetText), maxMinutes: Number(timeCap) });
  };

  return (
    <form className="dlg-inner profile-form" onSubmit={handleSubmit}>
      <div className="dlg-sticky-head">
        <div className="dlg-head">
          <div className="dlg-title-group">
            <span className="profile-title-badge" aria-hidden="true">
              <BotIcon size={18} />
            </span>
            <div className="dlg-title-meta">
              <h2 id="agent-profile-title">Agent Environment Profile</h2>
              <p className="note">Included in every copied agent brief so prompts match your local/VPS setup.</p>
            </div>
          </div>
          <button type="button" className="dlg-x" onClick={onClose} aria-label="Close agent profile dialog">
            <XIcon size={16} />
          </button>
        </div>
      </div>

      <div className="dlg-scroll-body profile-body">
        <div className="privacy-banner privacy-banner-tonal">
          <ShieldCheckIcon size={15} className="privacy-banner-icon" />
          <span>Stored locally in your browser only. Never enter seed phrases, private keys, passwords, or cookies.</span>
        </div>

        <CopyStatusBanner status={copyStatus} />

        {pendingCopyName && !copyStatus && (
          <div className="pending-copy-banner">
            <p className="pending-copy-text">
              Will copy the agent brief for <strong>{pendingCopyName}</strong> right after you save. Set up your
              environment below, then press “Save profile”.
            </p>
            <button type="button" className="chip" onClick={onCopyPending}>
              <CopyIcon size={13} />
              <span>Copy now without saving</span>
            </button>
          </div>
        )}

        <EnvironmentSection form={form} onUpdate={updateForm} />

        <GuardrailsSection
          form={form}
          budgetText={budgetText}
          timeCap={timeCap}
          onUpdate={updateForm}
          onBudgetChange={setBudgetText}
          onBudgetBlur={handleBudgetBlur}
          onTimeCapChange={setTimeCap}
        />
      </div>

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
