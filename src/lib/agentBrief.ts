import type { AgentProfile, Card, FeedItem } from '../../shared/types';
import { formatRelativeTime, isHttpUrl } from './format';

export const HUMAN_REQUIRED_RE =
  /captcha|turnstile|hcaptcha|recaptcha|verify (?:you are )?human|kyc|identity|selfie|passport|sign (?:the )?message|signature|approve|connect wallet|login with (?:x|twitter|discord|google|telegram)|oauth|phone (?:number|verification)|sms/i;

const ONCHAIN_TX_RE = /\b(?:swap|bridge|stake|restake|deposit|mint|claim|deploy|send tx|transaction)\b/i;
const HAN_RE = /\p{Script=Han}/gu;

const AGENT_PREAMBLE: Record<AgentProfile['agent'], string> = {
  hermes: 'You are Hermes running with tool access; follow each step strictly in order and pause on checkpoints.',
  openclaw: 'You are OpenClaw; execute browser/CLI steps deterministically and halt at every human checkpoint.',
  'claude-computer-use': 'You control a desktop; take a screenshot before each click and stop for every human checkpoint.',
  'browser-use': 'You control a browser session; inspect DOM state before acting and yield at every human checkpoint.',
  other: 'Follow each step sequentially, stay within budget/time caps, and pause at every human checkpoint.',
};

const TASK_TEMPLATES: Record<string, string> = {
  testnet: 'Complete the testnet interaction flow using testnet funds only',
  faucet: 'Request testnet tokens from the official faucet link above',
  quest: 'Open the quest campaign page and review eligible tasks',
  waitlist: 'Review waitlist/early-access registration details and submit required info (no passwords/keys)',
  bridge: 'Bridge a small test amount within the per-task budget cap',
  stake: 'Inspect staking/deposit terms and execute within the per-task cap',
  mint: 'Review mint details and gas cost before proceeding',
  points: 'Review points/epoch mechanics and execute qualifying low-cost actions',
  trade: 'Check minimum volume/trade requirements and keep slippage tight',
  social: 'Check social task requirements (Login with X/Discord/Telegram via OAuth if requested)',
  node: 'Inspect node/CLI requirements against the host specs below before installing anything',
  other: 'Inspect official project documentation and confirm task eligibility',
};

function sanitizeEnglish(input: string): string {
  return input.replace(HAN_RE, '').replace(/\s+/g, ' ').trim();
}

export function isFeedItem(item: FeedItem | Card): item is FeedItem {
  return 'sources' in item && 'risk' in item;
}

function formatStepLine(index: number, rawStep: string, forceHuman = false, isOnchain = false): string {
  const clean = sanitizeEnglish(rawStep) || 'Inspect task details';
  if (forceHuman || HUMAN_REQUIRED_RE.test(clean)) {
    return `${index}. ⛔ HUMAN-REQUIRED: ${clean} (pause, notify user, wait for "continue")`;
  }
  if (isOnchain || ONCHAIN_TX_RE.test(clean)) {
    return `${index}. ${clean} — ⛔ HUMAN-REQUIRED: user confirms transaction in wallet (pause, notify user, wait for "continue")`;
  }
  return `${index}. ${clean} (agent-doable)`;
}

function buildStepsForFeedItem(item: FeedItem): string[] {
  const steps: string[] = [];
  const types = item.taskTypes.length > 0 ? item.taskTypes : ['other'];
  for (const t of types) {
    const desc = TASK_TEMPLATES[t] ?? TASK_TEMPLATES.other;
    const isSocial = t === 'social';
    const isOnchain = t === 'bridge' || t === 'stake' || t === 'mint' || t === 'trade';
    steps.push(formatStepLine(steps.length + 1, desc, isSocial, isOnchain));
  }
  if (HUMAN_REQUIRED_RE.test(item.summary)) {
    steps.push(
      formatStepLine(
        steps.length + 1,
        'Post mentions verification/wallet-sign/login checkpoint — verify manually in browser',
        true,
      ),
    );
  }
  return steps;
}

/**
 * Sections identical for both brief kinds: preamble line, CAUTION note,
 * Constraints, Environment, Report back. Single source of truth so a wording
 * or policy change lands in both FeedItem and Card briefs.
 */
function buildStepsForCard(card: Card): string[] {
  const tasks = card.tasks?.length
    ? card.tasks
    : [
        {
          title: card.best.n,
          type: card.best.ty,
          status: 'OPEN',
          cost: card.costNum ?? 0,
          timeMinutes: null,
          url: card.url,
        },
      ];
  return tasks.map((t, i) => {
    const meta = [
      t.type || undefined,
      t.cost > 0 ? `~$${t.cost}` : 'Free',
      t.timeMinutes ? `${t.timeMinutes} min` : undefined,
      t.url && isHttpUrl(t.url) ? t.url : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
    const text = meta ? `${t.title} (${meta})` : t.title;
    const isSocial = /social|role|ambassador/i.test(t.type);
    const isOnchain = /trading|liquidity|staking|bridge|mint|mainnet/i.test(t.type);
    return formatStepLine(i + 1, text, isSocial, isOnchain);
  });
}

/**
 * Sections identical for both brief kinds. Single source of truth so a wording
 * or policy change lands in both FeedItem and Card briefs.
 */
function sharedHeaderLines(project: string, taskTypes: string, caution: string | null, profile: AgentProfile): string[] {
  const lines = [
    `# Task: ${project} — ${taskTypes}`,
    '',
    `> ${AGENT_PREAMBLE[profile.agent]}${profile.agentNote ? ` (${sanitizeEnglish(profile.agentNote)})` : ''}`,
  ];
  if (caution) lines.push('', `> CAUTION: ${caution}`);
  return lines;
}

function sharedTailLines(chains: string, profile: AgentProfile): string[] {
  return [
    '## Constraints',
    `- Budget cap: $${profile.budgetUsd}; time cap: ${profile.maxMinutes} min`,
    `- Chain(s): ${chains}; wallet: ${profile.wallet}${profile.walletNote ? ` (${sanitizeEnglish(profile.walletNote)})` : ''}`,
    '- Stop immediately and report if any page asks for a seed phrase / private key / unlimited token approval.',
    '- Never attempt to solve, click through, or bypass CAPTCHA / Turnstile / anti-bot challenges; pause and ask the user.',
    '',
    '## Environment',
    `- Agent: ${profile.agent} / Host: ${profile.host} / OS: ${profile.os} / Specs: ${sanitizeEnglish(profile.specs || 'standard')} / Browser mode: ${profile.browserMode} / Residential IP: ${profile.residentialIp ? 'yes' : 'no'}`,
    '',
    '## Report back',
    '- What was done, tx hashes, screenshots, anything skipped and why.',
  ];
}

export function buildBrief(item: FeedItem | Card, profile: AgentProfile): string | null {
  if (isFeedItem(item)) {
    if (item.risk.level === 'risk') return null;
    const project = sanitizeEnglish(item.project) || 'Web3 Project';
    const taskTypes = item.taskTypes.join(', ') || 'other';
    const chains = item.chains.join(', ') || 'Not specified';
    const verifiedLinks = item.links.filter(l => l.known && isHttpUrl(l.url)).map(l => `- ${l.url}`);
    const unverifiedLinks = item.links.filter(l => !l.known && isHttpUrl(l.url)).map(l => `- ${l.url}`);
    const steps = buildStepsForFeedItem(item);
    const sources = item.sources.map(
      s => `- @${s.handle} (${s.platform}) — ${s.postUrl} (${formatRelativeTime(s.postedAt)})`,
    );

    const lines: string[] = sharedHeaderLines(
      project,
      taskTypes,
      item.risk.level === 'warn'
        ? `Marked WARN (${item.risk.reasons.map(sanitizeEnglish).join('; ') || 'unverified source'}). Proceed carefully and verify official links first.`
        : null,
      profile,
    );

    lines.push(
      '',
      '## Goal',
      sanitizeEnglish(item.summary) || `Complete ${taskTypes} tasks for ${project}.`,
      '',
      '## Official links (verified)',
      ...(verifiedLinks.length > 0 ? verifiedLinks : ['- None verified yet — confirm official domain before interacting.']),
    );

    if (unverifiedLinks.length > 0) {
      lines.push('', '### Unverified, do NOT open', ...unverifiedLinks);
    }

    lines.push(
      '',
      '## Steps',
      ...steps,
      '',
      ...sharedTailLines(chains, profile),
      '',
      '## Sources',
      ...(sources.length > 0 ? sources : ['- Aggregated feed item']),
    );

    return lines.join('\n');
  }

  // Curated Card brief
  const project = sanitizeEnglish(item.n) || 'Web3 Project';
  const taskTypes = (item.taskTypes?.length ? item.taskTypes : [item.best.ty || 'airdrop']).join(', ');
  const chains = (item.chains?.length ? item.chains : item.chain ? [item.chain] : []).join(', ') || 'Not specified';
  const linkSet = new Set<string>();
  if (item.url && isHttpUrl(item.url)) linkSet.add(item.url);
  for (const t of item.tasks ?? []) {
    if (t.url && isHttpUrl(t.url)) linkSet.add(t.url);
  }
  const verifiedLinks = [...linkSet].map(u => `- ${u}`);
  const steps = buildStepsForCard(item);
  const hasRisk = item.b.includes('risk');

  const lines: string[] = sharedHeaderLines(
    project,
    taskTypes,
    hasRisk ? `Project carries a risk flag (${sanitizeEnglish(item.riskLabel || 'review carefully')}).` : null,
    profile,
  );

  lines.push(
    '',
    '## Goal',
    `Complete tracked ${taskTypes} tasks for ${project} (Tier ${item.g}, Funding ${item.f}).`,
    '',
    '## Official links (verified)',
    ...(verifiedLinks.length > 0 ? verifiedLinks : ['- No external task URL provided.']),
    '',
    '## Steps',
    ...steps,
    '',
    ...sharedTailLines(chains, profile),
    '',
    '## Sources',
    `- Curated Airdrop Radar (Rank #${item.r}, Tier ${item.g})`,
  );

  return lines.join('\n');
}
