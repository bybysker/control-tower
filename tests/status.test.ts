import { describe, expect, it } from 'vitest';
import {
  RUNNING_WINDOW_MS,
  STALLED_AFTER_MS,
  deriveStatus,
} from '../src/data/status.js';
import { parseSessionBody } from '../src/data/parse.js';
import { fixture } from './helpers.js';

const NOW = new Date('2026-09-01T12:00:00.000Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

/** Minimal signal bundle; each test overrides only what it is about. */
function signals(over: Partial<Parameters<typeof deriveStatus>[0]> = {}) {
  return {
    endsMidWork: false,
    lastToolErrored: false,
    lastToolRejectedByUser: false,
    lastStopReason: undefined,
    ...over,
  };
}

describe('running', () => {
  it('is running when recent AND ending mid-work', () => {
    const s = signals({ endsMidWork: true, lastStopReason: 'tool_use' });
    expect(deriveStatus(s, ago(2000), NOW)).toBe('running');
  });

  it('is NOT running on recency alone -- that cannot tell "just finished" from "still going"', () => {
    const s = signals({ endsMidWork: false, lastStopReason: 'end_turn' });
    expect(deriveStatus(s, ago(2000), NOW)).toBe('done');
  });

  it('drops out of running once the window closes', () => {
    const s = signals({ endsMidWork: true, lastStopReason: 'tool_use' });
    expect(deriveStatus(s, ago(RUNNING_WINDOW_MS + 1), NOW)).toBe('idle');
  });
});

describe('failed', () => {
  it('is failed when the last tool_result carried is_error === true', () => {
    const s = signals({ lastToolErrored: true, lastStopReason: 'tool_use' });
    expect(deriveStatus(s, ago(60_000), NOW)).toBe('failed');
  });

  it('is NOT failed when the error was the user declining the tool call', () => {
    const s = signals({ lastToolErrored: true, lastToolRejectedByUser: true });
    expect(deriveStatus(s, ago(60_000), NOW)).toBe('idle');
  });

  it('outranks a stale timestamp -- a failure stays visible as a failure', () => {
    const s = signals({ lastToolErrored: true });
    expect(deriveStatus(s, ago(STALLED_AFTER_MS * 10), NOW)).toBe('failed');
  });

  it('outranks running: a recent error is reported, not hidden behind activity', () => {
    const s = signals({ lastToolErrored: true, endsMidWork: false });
    expect(deriveStatus(s, ago(1000), NOW)).toBe('failed');
  });
});

describe('done', () => {
  it('is done when the last assistant record stopped on end_turn', () => {
    const s = signals({ lastStopReason: 'end_turn' });
    expect(deriveStatus(s, ago(60_000), NOW)).toBe('done');
  });

  it('stays done however old it gets -- a clean ending is not a stall', () => {
    const s = signals({ lastStopReason: 'end_turn' });
    expect(deriveStatus(s, ago(STALLED_AFTER_MS * 100), NOW)).toBe('done');
  });

  it('is not done when a user prompt arrived after the last end_turn', () => {
    const s = signals({ lastStopReason: 'end_turn', endsMidWork: true });
    expect(deriveStatus(s, ago(60_000), NOW)).not.toBe('done');
  });
});

describe('stalled', () => {
  it('is stalled when work was abandoned mid-flight long ago', () => {
    const s = signals({ endsMidWork: true, lastStopReason: 'tool_use' });
    expect(deriveStatus(s, ago(STALLED_AFTER_MS + 1), NOW)).toBe('stalled');
  });

  it('is still idle just inside the threshold', () => {
    const s = signals({ endsMidWork: true });
    expect(deriveStatus(s, ago(STALLED_AFTER_MS - 1000), NOW)).toBe('idle');
  });
});

describe('idle', () => {
  it('is the fallback for everything unremarkable', () => {
    expect(deriveStatus(signals({ endsMidWork: true }), ago(60_000), NOW)).toBe('idle');
    expect(deriveStatus(signals({ lastStopReason: 'stop_sequence' }), ago(60_000), NOW)).toBe('idle');
  });
});

describe('end-to-end over fixtures', () => {
  it('classifies a cleanly finished transcript as done', () => {
    const parsed = parseSessionBody(fixture('basic.jsonl'), 'a');
    expect(deriveStatus(parsed, new Date('2026-09-01T10:00:04.000Z'), new Date('2026-09-01T10:00:06.000Z'))).toBe('done');
  });

  it('classifies an abandoned permission prompt as stalled, not failed', () => {
    // Both sessions that first looked "failed" on the source machine were this.
    const parsed = parseSessionBody(fixture('rejected.jsonl'), 'r');
    expect(parsed.lastToolErrored).toBe(true);
    expect(deriveStatus(parsed, new Date('2026-08-14T09:00:02.000Z'), NOW)).toBe('stalled');
  });

  it('classifies an in-flight tool call as running', () => {
    const parsed = parseSessionBody(fixture('tasks.jsonl'), 't');
    const inFlight = { ...parsed, endsMidWork: true, lastStopReason: 'tool_use' };
    expect(deriveStatus(inFlight, ago(1000), NOW)).toBe('running');
  });
});
