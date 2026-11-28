import { useEffect, useState } from 'react';
import { MAX_CONTRIBUTION_BYTES, validateContribution, type ContributionResult } from '../../shared/contribution';
import type { StepOutcome, TaskManifestV1, TaskRefV1 } from '../../shared/taskContract';
import { copyText } from '../lib/clipboard';
import {
  blankIssueUrl,
  buildIssueUrl,
  contributionId,
  loadRecordedContributionIds,
  recordContributionId,
  type ContributionIssue,
} from '../lib/contributionIssue';
import { CopyStatusBanner, type CopyStatus } from './CopyStatusBanner';
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CopyIcon,
  GithubIcon,
  LinkIcon,
  ShieldCheckIcon,
  XIcon,
} from './Icons';
import { ModalDrawer } from './ModalDrawer';

interface Props {
  open: boolean;
  manifest: TaskManifestV1;
  refs: ReadonlyMap<string, TaskRefV1>;
  onClose: () => void;
}

/** The issue link together with the id it was built for. The id is empty when the browser cannot hash. */
type PreparedIssue = ContributionIssue & { id: string };

const OUTCOME_BADGE: Record<StepOutcome, string> = {
  pass: 'badge-live',
  fail: 'badge-risk',
  blocked: 'badge-warn',
  needs_user: 'badge-token',
  skipped: '',
};

interface OutcomeProps {
  result: ContributionResult | null;
  /** Null until the id of the latest accepted report is derived. */
  issue: PreparedIssue | null;
  /** This browser already recorded an issue for the accepted report. */
  duplicate: boolean;
  onCopyBody: () => void;
  onOpenIssue: () => void;
}

/**
 * Shows what the validator made of the report: the fixed rejection text, or a summary whose
 * titles and links all come from the reviewed task ref. It never renders pasted text itself.
 */
export function ContributionOutcome({ result, issue, duplicate, onCopyBody, onOpenIssue }: OutcomeProps) {
  if (!result) return null;
  if (!result.ok) {
    return (
      <p className="dlg-risk-callout" role="alert">
        <AlertTriangleIcon size={15} className="dlg-risk-icon" />
        <span>{result.message}</span>
      </p>
    );
  }
  const { preview } = result;
  const checkpoint = preview.checkpoint;
  return (
    <>
      <section className="profile-section contribution-preview" aria-labelledby="contribution-preview-title">
        <h3 id="contribution-preview-title" className="profile-section-title">
          <CheckCircle2Icon size={13} className="profile-section-icon" />
          <span>Valid report</span>
        </h3>
        <dl className="kv">
          <div>
            <dt>Task</dt>
            <dd>{preview.title}</dd>
          </div>
          <div>
            <dt>Task ID</dt>
            <dd>{preview.task_id}</dd>
          </div>
          <div>
            <dt>Revision</dt>
            <dd>v{preview.revision}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{preview.status}</dd>
          </div>
          <div>
            <dt>Ref SHA-256</dt>
            <dd className="mono">{preview.ref_sha256}</dd>
          </div>
          {Object.entries(preview.evidence).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>

        <h4 className="profile-section-title contribution-subhead">Attempted steps</h4>
        <ol className="drop-step-list">
          {preview.attempted_steps.map(step => (
            <li key={step.id} className="drop-step">
              <span className="drop-step-text">{step.title}</span>
              <span className={`badge ${OUTCOME_BADGE[step.outcome]}`}>{step.outcome}</span>
            </li>
          ))}
        </ol>

        <h4 className="profile-section-title contribution-subhead">Checkpoint</h4>
        {checkpoint ? (
          <dl className="kv">
            <div>
              <dt>ID</dt>
              <dd>
                {checkpoint.id} ({checkpoint.type})
              </dd>
            </div>
            <div>
              <dt>Human action needed now</dt>
              <dd>{checkpoint.human_action_required_now ? 'Yes' : 'No'}</dd>
            </div>
            <div>
              <dt>Action</dt>
              <dd>{checkpoint.action}</dd>
            </div>
            <div>
              <dt>Resume when</dt>
              <dd>{checkpoint.resume_when}</dd>
            </div>
          </dl>
        ) : (
          <p className="note">None. The run did not stop at a checkpoint.</p>
        )}

        <h4 className="profile-section-title contribution-subhead">Official sources</h4>
        {preview.sources.length === 0 ? (
          <p className="note">No source was read.</p>
        ) : (
          <ul className="drop-step-list">
            {preview.sources.map(source => (
              <li key={source.id} className="drop-step contribution-source">
                <a className="dlg-spec-link" href={source.url} target="_blank" rel="noopener noreferrer">
                  <LinkIcon size={13} />
                  {source.url}
                </a>
                <span className="badge">{source.kind}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {duplicate && (
        <p className="privacy-banner privacy-banner-tonal" role="status">
          <ShieldCheckIcon size={15} className="privacy-banner-icon" />
          <span>This browser already recorded an issue for this exact report. The record stays on this device.</span>
        </p>
      )}

      {issue?.url && (
        <>
          <div className="dlg-brief-bar">
            <a className="btn" href={issue.url} target="_blank" rel="noopener noreferrer" onClick={onOpenIssue}>
              <GithubIcon size={14} />
              <span>Open GitHub issue</span>
            </a>
          </div>
          <p className="note">Opens a prefilled issue in a new tab. Nothing reaches GitHub until you submit it there.</p>
        </>
      )}

      {issue?.tooLong && (
        <>
          <div className="dlg-brief-bar">
            <button type="button" className="btn" onClick={onCopyBody}>
              <CopyIcon size={14} />
              <span>Copy issue body</span>
            </button>
            <a className="btn btn-subtle" href={blankIssueUrl()} target="_blank" rel="noopener noreferrer">
              <GithubIcon size={14} />
              <span>Open blank issue form</span>
            </a>
          </div>
          <p className="note">The report is too long for a prefilled link. Copy the issue body and paste it into the form.</p>
        </>
      )}
    </>
  );
}

function ContributionForm({
  manifest,
  refs,
  onClose,
}: Pick<Props, 'manifest' | 'refs'> & { onClose: () => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<ContributionResult | null>(null);
  const [issue, setIssue] = useState<PreparedIssue | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [copyStatus, setCopyStatus] = useState<CopyStatus | null>(null);

  // Hashing is the one async step. The effect drops the answer of a result that was replaced meanwhile.
  useEffect(() => {
    if (!result?.ok) return;
    let current = true;
    const prepare = (id: string): void => {
      if (!current) return;
      setIssue({ ...buildIssueUrl(result.preview, result.canonical, id), id });
      setDuplicate(id !== '' && loadRecordedContributionIds().includes(id));
    };
    contributionId(result.canonical).then(prepare, () => prepare(''));
    return () => {
      current = false;
    };
  }, [result]);

  // Any edit invalidates the earlier verdict, so a link never points at text that is no longer in the box.
  const edit = (next: string): void => {
    setText(next);
    setResult(null);
    setIssue(null);
    setDuplicate(false);
    setCopyStatus(null);
  };

  const validate = (): void => {
    setCopyStatus(null);
    setIssue(null);
    setDuplicate(false);
    setResult(validateContribution(text, manifest, refs));
  };

  const copyBody = async (): Promise<void> => {
    if (!issue) return;
    const copied = await copyText(issue.body);
    setCopyStatus(
      copied
        ? { tone: 'ok', message: 'Issue body copied. Paste it into the GitHub form.' }
        : { tone: 'warn', message: 'Copy failed. Open the blank form and paste the report by hand.' },
    );
  };

  const openIssue = (): void => {
    if (!issue?.id) return;
    recordContributionId(issue.id);
    setDuplicate(true);
  };

  return (
    <div className="dlg-inner">
      <div className="dlg-sticky-head">
        <div className="dlg-head">
          <div className="dlg-title-group">
            <span className="profile-title-badge" aria-hidden="true">
              <ShieldCheckIcon size={18} />
            </span>
            <div className="dlg-title-meta">
              <h2 id="contribution-title">Validate contribution</h2>
              <p className="note">Paste one run report. Validation runs in this browser and sends nothing.</p>
            </div>
          </div>
          <button type="button" className="dlg-x" onClick={onClose} aria-label="Close contribution dialog">
            <XIcon size={16} />
          </button>
        </div>
      </div>

      <div className="dlg-scroll-body">
        <div className="privacy-banner privacy-banner-tonal">
          <ShieldCheckIcon size={15} className="privacy-banner-icon" />
          <span>Never paste seed phrases, private keys, passwords, cookies, or personal data. A rejected report shows a fixed reason only.</span>
        </div>

        <label className="field" htmlFor="contribution-input">
          <span>Run report JSON</span>
          <textarea
            id="contribution-input"
            className="contribution-input mono"
            value={text}
            maxLength={MAX_CONTRIBUTION_BYTES}
            onChange={event => edit(event.target.value)}
            aria-describedby="contribution-size"
            placeholder="Paste the run report JSON"
            rows={8}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
          />
          <span id="contribution-size" className="note">
            {new TextEncoder().encode(text).byteLength} / {MAX_CONTRIBUTION_BYTES} bytes
          </span>
        </label>

        <div className="dlg-brief-bar">
          <button type="button" className="btn" onClick={validate}>
            <CheckCircle2Icon size={14} />
            <span>Validate</span>
          </button>
        </div>

        <CopyStatusBanner status={copyStatus} />
        <div aria-live="polite">
          <ContributionOutcome
            result={result}
            issue={issue}
            duplicate={duplicate}
            onCopyBody={() => void copyBody()}
            onOpenIssue={openIssue}
          />
        </div>
      </div>
    </div>
  );
}

/** Modal that validates a pasted run report and prepares, but never posts, a GitHub issue. */
export function ContributionDialog({ open, manifest, refs, onClose }: Props) {
  return (
    <ModalDrawer id="contribution-dialog" labelledBy="contribution-title" open={open} onClose={onClose}>
      {dismiss => open && <ContributionForm manifest={manifest} refs={refs} onClose={dismiss} />}
    </ModalDrawer>
  );
}
