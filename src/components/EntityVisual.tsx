import { useId, useState, type CSSProperties, type ReactElement } from 'react';
import {
  advanceAvatarImageIndex,
  extractTickerFallback,
  getChainVisual,
  getCryptoVisual,
  getSourceVisual,
  resolveEntityVisual,
  sanitizeImageUrl,
  type BrandPalette,
  type ChainVisual,
  type CryptoVisual,
  type GeometricKind,
  type ProjectLogoIndex,
  type ResolvedEntityVisual,
  type SourceIconKind,
  type SvgPrimitive,
} from '../lib/visualAssets';
import {
  CoinsIcon,
  CompassIcon,
  DatabaseIcon,
  FlameIcon,
  GithubIcon,
  GlobeIcon,
  LayersIcon,
  PercentIcon,
  RadarIcon,
  RssIcon,
  SheetIcon,
  SparklesIcon,
  TargetIcon,
  TelegramIcon,
  TrendingUpIcon,
  XBrandIcon,
} from './Icons';

export interface EntityAvatarProps {
  name: string;
  src?: string | null;
  img?: string | null;
  logo?: string | null;
  icon?: string | null;
  imageUrls?: readonly string[];
  ticker?: string | null;
  symbol?: string | null;
  id?: string | null;
  protocolSlug?: string | null;
  source?: string | null;
  url?: string | null;
  domain?: string | null;
  chain?: string | null;
  sectionId?: string | null;
  logoIndex?: ProjectLogoIndex | null;
  resolved?: ResolvedEntityVisual;
  size?: number;
  shape?: 'rounded' | 'circle';
  className?: string;
}

export interface ChainBadgeProps {
  chain: string;
  compact?: boolean;
  size?: number;
  className?: string;
}

export interface PlatformBadgeProps {
  source: string;
  label?: string;
  size?: number;
  className?: string;
}

export interface CryptoTickerPillProps {
  ticker: string;
  prefix?: boolean;
  size?: number;
  className?: string;
}

function renderSvgPrimitive(shape: SvgPrimitive, key: string): ReactElement {
  switch (shape.tag) {
    case 'path':
      return (
        <path
          key={key}
          d={shape.d}
          fill={shape.fill ?? 'none'}
          stroke={shape.stroke}
          strokeWidth={shape.strokeWidth}
          opacity={shape.opacity}
          fillRule={shape.fillRule}
          strokeLinecap={shape.strokeLinecap}
          strokeLinejoin={shape.strokeLinejoin}
        />
      );
    case 'circle':
      return (
        <circle
          key={key}
          cx={shape.cx}
          cy={shape.cy}
          r={shape.r}
          fill={shape.fill ?? 'none'}
          stroke={shape.stroke}
          strokeWidth={shape.strokeWidth}
          opacity={shape.opacity}
        />
      );
    case 'rect':
      return (
        <rect
          key={key}
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          rx={shape.rx}
          fill={shape.fill ?? 'none'}
          stroke={shape.stroke}
          strokeWidth={shape.strokeWidth}
          opacity={shape.opacity}
          transform={shape.transform}
        />
      );
    case 'polygon':
      return (
        <polygon
          key={key}
          points={shape.points}
          fill={shape.fill ?? 'none'}
          stroke={shape.stroke}
          strokeWidth={shape.strokeWidth}
          opacity={shape.opacity}
        />
      );
    case 'line':
      return (
        <line
          key={key}
          x1={shape.x1}
          y1={shape.y1}
          x2={shape.x2}
          y2={shape.y2}
          stroke={shape.stroke}
          strokeWidth={shape.strokeWidth}
          opacity={shape.opacity}
          strokeLinecap={shape.strokeLinecap}
        />
      );
    case 'ellipse':
      return (
        <ellipse
          key={key}
          cx={shape.cx}
          cy={shape.cy}
          rx={shape.rx}
          ry={shape.ry}
          fill={shape.fill ?? 'none'}
          stroke={shape.stroke}
          strokeWidth={shape.strokeWidth}
          opacity={shape.opacity}
          transform={shape.transform}
        />
      );
  }
}

function CryptoCoinSvg({ visual, size }: { visual: CryptoVisual; size: number }) {
  const gradId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      style={{ display: 'block', width: '100%', height: '100%', color: visual.fg }}
    >
      {visual.bgEnd ? (
        <defs>
          <linearGradient id={gradId} x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor={visual.bg} />
            <stop offset="100%" stopColor={visual.bgEnd} />
          </linearGradient>
        </defs>
      ) : null}
      <rect width="32" height="32" fill={visual.bgEnd ? `url(#${gradId})` : visual.bg} />
      {visual.shapes.map((shape, idx) => renderSvgPrimitive(shape, `${visual.symbol}-${idx}`))}
    </svg>
  );
}

function ChainAvatarSvg({ visual, size }: { visual: ChainVisual; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{
        display: 'block',
        width: '100%',
        height: '100%',
        color: '#FFFFFF',
        background: visual.color,
      }}
    >
      <rect width="24" height="24" fill={visual.color} />
      <g transform="translate(2.4 2.4) scale(0.8)">
        {visual.shapes.map((shape, idx) => renderSvgPrimitive(shape, `${visual.id}-${idx}`))}
      </g>
    </svg>
  );
}

function GeometricMotif({ kind, accent }: { kind: GeometricKind; accent: string }) {
  switch (kind) {
    case 'hex':
      return (
        <polygon
          points="16,2.5 27.5,9.2 27.5,22.8 16,29.5 4.5,22.8 4.5,9.2"
          stroke={accent}
          strokeWidth="1.2"
          opacity="0.26"
        />
      );
    case 'diamond':
      return (
        <polygon
          points="16,2.5 29.5,16 16,29.5 2.5,16"
          stroke={accent}
          strokeWidth="1.2"
          opacity="0.26"
        />
      );
    case 'orbit':
      return (
        <>
          <ellipse cx="16" cy="16" rx="13" ry="6" stroke={accent} strokeWidth="1.15" opacity="0.24" transform="rotate(-28 16 16)" />
          <circle cx="25.5" cy="10.5" r="1.6" fill={accent} opacity="0.34" />
        </>
      );
    case 'prism':
      return (
        <polygon
          points="16,3.5 28.5,26.5 3.5,26.5"
          stroke={accent}
          strokeWidth="1.2"
          opacity="0.25"
        />
      );
    case 'shield':
      return (
        <path
          d="M16 3.5 26.5 7.5v7.5c0 6-4.2 10.6-10.5 13-6.3-2.4-10.5-7-10.5-13V7.5L16 3.5Z"
          stroke={accent}
          strokeWidth="1.2"
          opacity="0.26"
        />
      );
    case 'cube':
      return (
        <>
          <rect x="6" y="6" width="20" height="20" rx="4" stroke={accent} strokeWidth="1.15" opacity="0.24" transform="rotate(14 16 16)" />
          <circle cx="24" cy="8" r="1.8" fill={accent} opacity="0.28" />
        </>
      );
    case 'wave':
      return (
        <>
          <path d="M2 23c4.5-3.5 9.5-3.5 14 0s9.5 3.5 14 0" stroke={accent} strokeWidth="1.5" opacity="0.28" />
          <path d="M2 10c4.5-3.5 9.5-3.5 14 0s9.5 3.5 14 0" stroke={accent} strokeWidth="1.3" opacity="0.2" />
        </>
      );
    case 'spark':
      return (
        <>
          <circle cx="24.5" cy="7.5" r="5" fill={accent} opacity="0.16" />
          <path d="M24.5 4.5v6M21.5 7.5h6" stroke={accent} strokeWidth="1.2" strokeLinecap="round" opacity="0.36" />
        </>
      );
  }
}

function GeometricEmblemSvg({
  palette,
  kind,
  monogram,
  size,
}: {
  palette: BrandPalette;
  kind: GeometricKind;
  monogram: string;
  size: number;
}) {
  const gradId = useId();
  const fontSize = monogram.length > 1 ? 11.5 : 13.5;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      style={{ display: 'block', width: '100%', height: '100%' }}
    >
      <defs>
        <linearGradient id={gradId} x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={palette.bgStart} />
          <stop offset="100%" stopColor={palette.bgEnd} />
        </linearGradient>
      </defs>
      <rect width="32" height="32" fill={`url(#${gradId})`} />
      <GeometricMotif kind={kind} accent={palette.accent} />
      <text
        x="16"
        y="16.5"
        textAnchor="middle"
        dominantBaseline="central"
        fill={palette.fg}
        fontSize={fontSize}
        fontWeight="700"
        fontFamily="var(--font-sans, system-ui, sans-serif)"
        letterSpacing="-0.02em"
      >
        {monogram}
      </text>
    </svg>
  );
}

function collectAvatarUrls(
  explicitUrls: readonly string[] | undefined,
  directUrls: readonly (string | null | undefined)[],
  resolvedUrls: readonly string[],
): string[] {
  const out: string[] = [];
  const push = (value: string | null | undefined) => {
    const safe = sanitizeImageUrl(value);
    if (safe && !out.includes(safe)) out.push(safe);
  };
  if (explicitUrls) {
    for (const url of explicitUrls) push(url);
  }
  for (const url of directUrls) push(url);
  for (const url of resolvedUrls) push(url);
  return out;
}

function avatarBorderRadius(size: number, shape: 'rounded' | 'circle'): string {
  if (shape === 'circle') return '50%';
  if (size <= 22) return '6px';
  if (size <= 28) return '7px';
  return 'var(--radius-element)';
}

export function EntityAvatar({
  name,
  src,
  img,
  logo,
  icon,
  imageUrls,
  ticker,
  symbol,
  id,
  protocolSlug,
  source,
  url,
  domain,
  chain,
  sectionId,
  logoIndex,
  resolved,
  size = 36,
  shape = 'rounded',
  className,
}: EntityAvatarProps) {
  const visual =
    resolved ??
    resolveEntityVisual({
      name,
      img: img ?? src,
      logo,
      icon,
      ticker,
      symbol,
      id,
      protocolSlug,
      source,
      url,
      domain,
      chain,
      sectionId,
      logoIndex,
    });

  const urls = collectAvatarUrls(imageUrls, [src, img, logo, icon], visual.imageUrls);
  const urlsKey = urls.join('\n');

  const [imgState, setImgState] = useState<{ key: string; index: number; loadedUrl: string | null }>({
    key: urlsKey,
    index: 0,
    loadedUrl: null,
  });

  const activeIndex = imgState.key === urlsKey ? imgState.index : 0;
  const activeUrl = activeIndex < urls.length ? urls[activeIndex] : null;
  const isLoaded = Boolean(activeUrl && imgState.key === urlsKey && imgState.loadedUrl === activeUrl);

  const handleImageError = () => {
    setImgState(prev => {
      const currentIdx = prev.key === urlsKey ? prev.index : 0;
      return {
        key: urlsKey,
        index: advanceAvatarImageIndex(currentIdx, urls.length),
        loadedUrl: null,
      };
    });
  };

  const handleImageLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    if (event.currentTarget.naturalWidth === 0) {
      handleImageError();
      return;
    }
    if (!activeUrl) return;
    setImgState({
      key: urlsKey,
      index: activeIndex,
      loadedUrl: activeUrl,
    });
  };

  const radius = avatarBorderRadius(size, shape);
  const rootStyle: CSSProperties = {
    width: size,
    height: size,
    borderRadius: radius,
    flexShrink: 0,
  };

  const imgStyle: CSSProperties = {
    backgroundColor: isLoaded ? 'var(--color-background-surface)' : 'transparent',
  };

  const rootClass = className ? `avatar entity-avatar ${className}` : 'avatar entity-avatar';

  return (
    <span className={rootClass} style={rootStyle} aria-hidden="true">
      {!isLoaded &&
        (visual.cryptoVisual ? (
          <CryptoCoinSvg visual={visual.cryptoVisual} size={size} />
        ) : visual.isChainEntity && visual.chainVisual ? (
          <ChainAvatarSvg visual={visual.chainVisual} size={size} />
        ) : (
          <GeometricEmblemSvg
            palette={visual.palette}
            kind={visual.geometricKind}
            monogram={visual.monogram}
            size={size}
          />
        ))}
      {activeUrl && (
        <img
          key={activeUrl}
          src={activeUrl}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          width={size}
          height={size}
          style={imgStyle}
          onError={handleImageError}
          onLoad={handleImageLoad}
        />
      )}
    </span>
  );
}

function ChainGlyphSvg({ visual, size }: { visual: ChainVisual; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="chain-badge-icon"
      style={{ color: visual.color, flexShrink: 0, display: 'block' }}
    >
      {visual.shapes.map((shape, idx) => renderSvgPrimitive(shape, `${visual.id}-glyph-${idx}`))}
    </svg>
  );
}

export function ChainBadge({ chain, compact = false, size = 13, className }: ChainBadgeProps) {
  const trimmed = chain.trim();
  if (!trimmed) return null;

  const visual = getChainVisual(trimmed);
  const fullLabel = visual ? visual.label : trimmed;
  const displayLabel = compact && visual ? visual.shortLabel : fullLabel;
  const rootClass = className ? `typetip chain-badge ${className}` : 'typetip chain-badge';
  const style: CSSProperties = {
    gap: '4px',
    ...(visual ? { borderColor: visual.bgTint } : undefined),
  };

  return (
    <span
      className={rootClass}
      style={style}
      title={fullLabel}
      aria-label={compact ? fullLabel : undefined}
      data-compact={compact ? 'true' : undefined}
    >
      {visual ? (
        <ChainGlyphSvg visual={visual} size={size} />
      ) : (
        <GlobeIcon size={size} className="chain-badge-icon" />
      )}
      <span>{displayLabel}</span>
    </span>
  );
}

function renderSourceIcon(kind: SourceIconKind, size: number, color: string): ReactElement {
  const style: CSSProperties = { color, flexShrink: 0 };
  switch (kind) {
    case 'telegram':
      return <TelegramIcon size={size} style={style} />;
    case 'x':
      return <XBrandIcon size={size} style={style} />;
    case 'github':
      return <GithubIcon size={size} style={style} />;
    case 'rss':
      return <RssIcon size={size} style={style} />;
    case 'sheet':
      return <SheetIcon size={size} style={style} />;
    case 'compass':
      return <CompassIcon size={size} style={style} />;
    case 'coins':
      return <CoinsIcon size={size} style={style} />;
    case 'layers':
      return <LayersIcon size={size} style={style} />;
    case 'percent':
      return <PercentIcon size={size} style={style} />;
    case 'target':
      return <TargetIcon size={size} style={style} />;
    case 'trending':
      return <TrendingUpIcon size={size} style={style} />;
    case 'sparkles':
      return <SparklesIcon size={size} style={style} />;
    case 'radar':
      return <RadarIcon size={size} style={style} />;
    case 'flame':
      return <FlameIcon size={size} style={style} />;
    case 'database':
      return <DatabaseIcon size={size} style={style} />;
    case 'globe':
      return <GlobeIcon size={size} style={style} />;
  }
}

export function PlatformBadge({ source, label, size = 13, className }: PlatformBadgeProps) {
  const visual = getSourceVisual(source);
  const text = label?.trim() || visual.label;
  const rootClass = className ? `typetip platform-badge ${className}` : 'typetip platform-badge';

  return (
    <span className={rootClass} style={{ gap: '4px' }} title={`Source: ${text}`}>
      {renderSourceIcon(visual.iconKind, size, visual.color)}
      <span>{text}</span>
    </span>
  );
}

export function CryptoTickerPill({
  ticker,
  prefix = true,
  size = 14,
  className,
}: CryptoTickerPillProps) {
  const cleaned = extractTickerFallback(null, ticker) ?? ticker.trim().replace(/^\$+/, '').toUpperCase();
  if (!cleaned) return null;

  const visual = getCryptoVisual(cleaned);
  const rootClass = className
    ? `market-ticker-badge crypto-ticker-pill mono ${className}`
    : 'market-ticker-badge crypto-ticker-pill mono';

  return (
    <span className={rootClass} style={{ gap: '4px' }} title={visual ? `${visual.name} ($${cleaned})` : `$${cleaned}`}>
      {visual && (
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: size,
            height: size,
            borderRadius: '50%',
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          <CryptoCoinSvg visual={visual} size={size} />
        </span>
      )}
      <span>{prefix ? `$${cleaned}` : cleaned}</span>
    </span>
  );
}
