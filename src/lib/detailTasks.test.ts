import { describe, expect, test } from 'bun:test';
import type { CardTask } from '../../shared/types';
import { orderDetailTasks } from './detailTasks';

function makeTask(title: string, status: string, type = 'On-chain'): CardTask {
  return {
    title,
    type,
    status,
    cost: 0,
    timeMinutes: 5,
    url: 'https://example.com',
  };
}

describe('orderDetailTasks', () => {
  test('orders OPEN and active tasks before CLOSED tasks while preserving originalIndex', () => {
    const tasks: CardTask[] = [
      makeTask('Legacy campaign', 'CLOSED'),
      makeTask('Bridge to testnet', 'OPEN'),
      makeTask('Season 1 quest', 'closed'),
      makeTask('Daily check-in', ''),
      makeTask('Mint genesis NFT', ' open '),
    ];

    const ordered = orderDetailTasks(tasks);
    expect(ordered.map(entry => [entry.task.title, entry.originalIndex, entry.isClosed])).toEqual([
      ['Bridge to testnet', 1, false],
      ['Daily check-in', 3, false],
      ['Mint genesis NFT', 4, false],
      ['Legacy campaign', 0, true],
      ['Season 1 quest', 2, true],
    ]);
  });

  test('preserves relative order when all tasks are open or all tasks are closed', () => {
    const allOpen = [makeTask('First', 'OPEN'), makeTask('Second', 'ACTIVE'), makeTask('Third', '')];
    expect(orderDetailTasks(allOpen).map(e => [e.task.title, e.originalIndex, e.isClosed])).toEqual([
      ['First', 0, false],
      ['Second', 1, false],
      ['Third', 2, false],
    ]);

    const allClosed = [makeTask('Old A', 'CLOSED'), makeTask('Old B', ' Closed ')];
    expect(orderDetailTasks(allClosed).map(e => [e.task.title, e.originalIndex, e.isClosed])).toEqual([
      ['Old A', 0, true],
      ['Old B', 1, true],
    ]);
  });

  test('handles empty input without mutating the source array', () => {
    expect(orderDetailTasks([])).toEqual([]);

    const source = [makeTask('Closed first', 'CLOSED'), makeTask('Open second', 'OPEN')];
    const snapshot = source.map(t => t.title);
    const ordered = orderDetailTasks(source);

    expect(source.map(t => t.title)).toEqual(snapshot);
    expect(ordered[0].task.title).toBe('Open second');
    expect(ordered[0].originalIndex).toBe(1);
    expect(ordered[1].task.title).toBe('Closed first');
    expect(ordered[1].originalIndex).toBe(0);
  });

  test('preserves distinct originalIndex values for duplicate task titles', () => {
    const tasks = [
      makeTask('Complete quest', 'CLOSED', 'Social'),
      makeTask('Complete quest', 'OPEN', 'Social'),
      makeTask('Complete quest', 'CLOSED', 'Social'),
    ];
    const ordered = orderDetailTasks(tasks);
    expect(ordered.map(e => [e.originalIndex, e.isClosed])).toEqual([
      [1, false],
      [0, true],
      [2, true],
    ]);
  });
});
