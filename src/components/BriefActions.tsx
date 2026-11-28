import type { AgentProfile, Card, FeedItem } from '../../shared/types';
import { buildBrief, describeBrief } from '../lib/agentBrief';
import { downloadMarkdown } from '../lib/clipboard';
import { getRefBaseUrl } from '../hooks/useCopyBriefController';
import { CopyIcon, DownloadIcon, EyeIcon, EyeOffIcon, InfoIcon, ShieldAlertIcon, ShieldCheckIcon } from './Icons';

interface Props<T extends FeedItem | Card> {
  target: T;
  profile: AgentProfile;
  slug: string;
  /** True for RISK targets: the guardrail notice replaces the actions because no brief is generated. */
  blocked: boolean;
  showBrief: boolean;
  onToggleBrief: () => void;
  onCopyBrief: (target: T) => void;
}

/**
 * Which brief Copy produces for an item that is not RISK: a reviewed playbook,
 * or a brief built from item data. Show it only next to a working Copy action.
 */
export function BriefBadge({ item, className }: { item: FeedItem | Card; className?: string }) {
  const { verified, badge, label } = describeBrief(item);
  const Icon = verified ? ShieldCheckIcon : InfoIcon;
  const classes = `brief-badge ${verified ? 'is-verified' : 'is-unverified'}${className ? ` ${className}` : ''}`;
  return (
    <span className={classes} title={label}>
      <Icon size={12} />
      <span>{badge}</span>
    </span>
  );
}

/** Copy, preview, and download controls for an agent brief, or the RISK guardrail notice. */
export function BriefActions<T extends FeedItem | Card>({
  target,
  profile,
  slug,
  blocked,
  showBrief,
  onToggleBrief,
  onCopyBrief,
}: Props<T>) {
  if (blocked) {
    return (
      <div className="dlg-risk-callout">
        <ShieldAlertIcon size={15} className="dlg-risk-icon" />
        <p className="note risk-blocked">Brief unavailable for RISK items.</p>
      </div>
    );
  }

  return (
    <div className="dlg-brief-bar">
      <button type="button" className="btn" onClick={() => onCopyBrief(target)}>
        <CopyIcon size={14} />
        <span>Copy agent brief</span>
      </button>
      <button type="button" className="chip" aria-expanded={showBrief} onClick={onToggleBrief}>
        {showBrief ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
        <span>{showBrief ? 'Hide preview' : 'Preview brief'}</span>
      </button>
      <button
        type="button"
        className="chip"
        onClick={() => {
          // Same context as Copy and Preview, so all three produce the same bytes.
          const md = buildBrief(target, profile, { refBaseUrl: getRefBaseUrl() });
          if (md) downloadMarkdown(`${slug}-agent-brief.md`, md);
        }}
      >
        <DownloadIcon size={14} />
        <span>Download .md</span>
      </button>
      <BriefBadge item={target} />
    </div>
  );
}
