import type { CardTask } from '../../shared/types';

export interface OrderedDetailTask {
  task: CardTask;
  originalIndex: number;
  isClosed: boolean;
}

/**
 * Orders project detail tasks with OPEN / active tasks first and CLOSED tasks
 * below, while preserving each task's `originalIndex` so done-task storage keys
 * remain 100% backward-compatible.
 */
export function orderDetailTasks(tasks: readonly CardTask[]): OrderedDetailTask[] {
  const open: OrderedDetailTask[] = [];
  const closed: OrderedDetailTask[] = [];

  for (let originalIndex = 0; originalIndex < tasks.length; originalIndex++) {
    const task = tasks[originalIndex];
    const isClosed = task.status.trim().toUpperCase() === 'CLOSED';
    const entry: OrderedDetailTask = { task, originalIndex, isClosed };
    if (isClosed) {
      closed.push(entry);
    } else {
      open.push(entry);
    }
  }

  return [...open, ...closed];
}
