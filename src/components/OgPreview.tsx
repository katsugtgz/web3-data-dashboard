import { useState } from 'react';
import type { OgPreviewData } from '../lib/visualAssets';

/**
 * - `strip`: image-only band across the top of a card.
 * - `banner`: wide image band inside a detail dialog.
 * - `card`: image plus title and description inside a detail dialog.
 */
export type OgPreviewVariant = 'strip' | 'banner' | 'card';

interface Props {
  /** Sanitized preview from `resolveOgPreview`; null renders nothing. */
  preview: OgPreviewData | null;
  variant: OgPreviewVariant;
}

/**
 * Image inside a reserved aspect-ratio box. A broken image is swapped for a
 * tonal placeholder in the same box, so content below never shifts.
 */
function OgMedia({ image }: { image: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = failedUrl === image;

  return (
    <span className={`og-media${failed ? ' is-failed' : ''}`}>
      {!failed && (
        <img
          src={image}
          alt=""
          width={1200}
          height={630}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(image)}
        />
      )}
    </span>
  );
}

function OgCaption({ title, description }: { title: string | null; description: string | null }) {
  return (
    <figcaption className="og-caption">
      {title && <span className="og-title">{title}</span>}
      {description && <span className="og-description">{description}</span>}
    </figcaption>
  );
}

function frameClass(variant: OgPreviewVariant, hasImage: boolean): string {
  return `og-${variant}${hasImage ? '' : ' is-text-only'}`;
}

/** Open Graph preview. Bands (`strip`, `banner`) need an image; `card` also shows text alone. */
export function OgPreview({ preview, variant }: Props) {
  if (!preview) return null;
  const hasImage = Boolean(preview.image);
  if (!hasImage && variant !== 'card') return null;

  const media = preview.image ? <OgMedia image={preview.image} /> : null;

  if (variant === 'strip') {
    return (
      <div className="og-strip" aria-hidden="true">
        {media}
      </div>
    );
  }

  return (
    <figure className={frameClass(variant, hasImage)}>
      {media}
      {variant === 'card' && <OgCaption title={preview.title} description={preview.description} />}
      {variant === 'banner' && <figcaption className="sr">Site preview image</figcaption>}
    </figure>
  );
}
