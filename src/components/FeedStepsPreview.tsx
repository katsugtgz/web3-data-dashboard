const PREVIEW_STEPS = 3;

/** First few task steps of a drop; the full numbered list lives in the detail drawer. */
export function FeedStepsPreview({ steps }: { steps: readonly string[] }) {
  if (steps.length === 0) return null;
  const hidden = steps.length - PREVIEW_STEPS;

  return (
    <ol className="feed-steps" aria-label="Task steps preview">
      {steps.slice(0, PREVIEW_STEPS).map((step, index) => (
        <li key={step} className="feed-step">
          <span className="feed-step-num mono" aria-hidden="true">
            {index + 1}
          </span>
          <span className="feed-step-text">{step}</span>
        </li>
      ))}
      {hidden > 0 && (
        <li className="feed-step-more note">
          +{hidden} more in details
        </li>
      )}
    </ol>
  );
}
