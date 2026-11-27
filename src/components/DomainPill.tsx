import { GlobeIcon, ShieldCheckIcon } from './Icons';

interface Props {
  /** `true` = domain verified, `false` = not verified yet, undefined = unknown (renders nothing). */
  verified: boolean | null | undefined;
  domain?: string | null;
}

/**
 * Domain trust badge. An unverified domain is the normal state for a young
 * project, so it reads as a muted note here and never as an alert; real security
 * signals stay in the separate Warn/Risk badge.
 */
export function DomainPill({ verified, domain }: Props) {
  if (verified === undefined || verified === null) return null;

  if (verified) {
    return (
      <span className="badge pill-verified" title={domain ? `Domain verified: ${domain}` : 'Project domain verified'}>
        <ShieldCheckIcon size={11} />
        <span>Verified</span>
      </span>
    );
  }

  return (
    <span
      className="badge pill-unverified"
      title={
        domain
          ? `Domain not verified yet: ${domain}. This is a note, not a security alert.`
          : 'Project domain not verified yet. This is a note, not a security alert.'
      }
    >
      <GlobeIcon size={11} />
      <span>Unverified</span>
    </span>
  );
}
