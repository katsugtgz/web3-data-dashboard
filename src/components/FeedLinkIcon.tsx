import { CheckCircle2Icon, GithubIcon, GlobeIcon, SheetIcon, TelegramIcon, XBrandIcon } from './Icons';

/** Leading icon for a link pill: a check for verified links, otherwise the platform's mark. */
export function FeedLinkLeadingIcon({ url, known }: { url: string; known: boolean }) {
  if (known) {
    return <CheckCircle2Icon size={13} className="feed-link-verified" />;
  }
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (host === 't.me' || host === 'telegram.me') {
      return <TelegramIcon size={12} className="feed-link-platform is-telegram" />;
    }
    if (host === 'x.com' || host === 'twitter.com') {
      return <XBrandIcon size={12} className="feed-link-platform is-x" />;
    }
    if (host === 'github.com') {
      return <GithubIcon size={12} className="feed-link-platform is-github" />;
    }
    if (host === 'docs.google.com') {
      return <SheetIcon size={12} className="feed-link-platform is-sheet" />;
    }
  } catch {
    // Fall back to the globe icon for any unparseable href.
  }
  return <GlobeIcon size={12} className="feed-link-platform" />;
}
