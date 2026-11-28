import { lazy, Suspense } from 'react';
import { BUNDLED_TASK_REGISTRY } from '../lib/taskRegistry';
import { ChunkErrorBoundary } from './ChunkErrorBoundary';

const ContributionDialog = lazy(() => import('./ContributionDialog').then(m => ({ default: m.ContributionDialog })));

/**
 * The contribution validator in its own chunk, run over the task registry bundled at build time.
 * It mounts only while open, so each opening retries a chunk that failed to load.
 */
export function ContributionDialogLazy({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <ChunkErrorBoundary label="contribution validator" onReset={onClose}>
      <Suspense fallback={null}>
        <ContributionDialog
          open
          manifest={BUNDLED_TASK_REGISTRY.manifest}
          refs={BUNDLED_TASK_REGISTRY.byTaskId}
          onClose={onClose}
        />
      </Suspense>
    </ChunkErrorBoundary>
  );
}
