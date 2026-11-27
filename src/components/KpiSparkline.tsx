import {
  bucketDaily,
  describeBuckets,
  sparklineArea,
  sparklinePoints,
  SPARK_HEIGHT,
  SPARK_WIDTH,
  type BarSegment,
} from '../lib/viz';

/** Inline SVG line chart of a short daily series. Decorative: the label carries the meaning. */
export function KpiSparkline({ values, label }: { values: readonly number[]; label: string }) {
  const points = sparklinePoints(values);
  return (
    <span className="kpi-sparkline">
      <svg
        viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
        className="kpi-spark-svg"
      >
        <path className="kpi-spark-area" d={sparklineArea(points)} />
        <polyline className="kpi-spark-line" points={points} vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="sr">{label}</span>
    </span>
  );
}

interface MiniBarsProps {
  segments: readonly BarSegment[];
  /** Describes the whole bar for screen readers, e.g. "Tiers: S 15, A 57". */
  label: string;
}

/** One stacked bar with a legend. Segments with a zero count are left out. */
export function MiniBars({ segments, label }: MiniBarsProps) {
  const visible = segments.filter(segment => segment.value > 0);
  const total = visible.reduce((sum, segment) => sum + segment.value, 0);
  if (visible.length === 0 || total === 0) return null;

  return (
    <span className="kpi-dist" role="img" aria-label={label}>
      <span className="kpi-dist-bar" aria-hidden="true">
        {visible.map(segment => (
          <span
            key={segment.id}
            className={`kpi-dist-seg is-${segment.tone}`}
            style={{ width: `${(segment.value / total) * 100}%` }}
          />
        ))}
      </span>
      <span className="kpi-dist-legend" aria-hidden="true">
        {visible.map(segment => (
          <span key={segment.id} className="kpi-dist-item">
            <span className={`kpi-dist-dot is-${segment.tone}`} />
            <span>{segment.label}</span>
            <b className="mono">{segment.value}</b>
          </span>
        ))}
      </span>
    </span>
  );
}

/** Seven-day activity line (ms timestamps in, newest bucket last). */
export function KpiActivity({ timestamps, label }: { timestamps: readonly number[]; label: string }) {
  const buckets = bucketDaily(timestamps, Date.now());
  const caption = describeBuckets(buckets);
  return (
    <>
      <KpiSparkline values={buckets} label={`${label}: ${caption}`} />
      <span className="kpi-viz-note" aria-hidden="true">
        {caption}
      </span>
    </>
  );
}
