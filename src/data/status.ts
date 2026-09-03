import type { ParsedSession, Status } from './types.js';

/**
 * Status derivation.
 *
 * These are DEDUCTIONS, not facts. Claude Code writes no status field --
 * nothing on disk says "this session is running". Every rule below infers state
 * from the shape and recency of the transcript tail, and each can be wrong.
 * The failure modes are enumerated in docs/status-heuristics.md; the important
 * ones: a session blocked on a permission prompt is indistinguishable from one
 * actively working, and a long-running Bash call looks idle because it writes
 * nothing for its duration.
 */

/** A working session appends every few seconds; 10s absorbs a slow tool call. */
export const RUNNING_WINDOW_MS = 10_000;
/** Long enough that stepping away for a coffee does not trip it. */
export const STALLED_AFTER_MS = 30 * 60 * 1000;

export function deriveStatus(
  parsed: Pick<
    ParsedSession,
    'endsMidWork' | 'lastToolErrored' | 'lastToolRejectedByUser' | 'lastStopReason'
  >,
  lastActivity: Date,
  now: Date = new Date(),
): Status {
  const age = now.getTime() - lastActivity.getTime();

  // running: recent AND ending mid-work. The second clause is load-bearing --
  // recency alone cannot tell "just finished" from "still going".
  if (age < RUNNING_WINDOW_MS && parsed.endsMidWork) return 'running';

  // failed: only is_error === true. `null` is 561 of 1047 observed tool_results
  // and means "field not written", not "failure". We deliberately do not grep
  // transcript text for "error"/"failed" -- a session discussing an error is
  // not a failed session, and this tool exists to watch exactly those.
  // A DECLINED permission prompt also carries is_error: true, but the session
  // did not fail -- the human said no. Both sessions that looked failed on the
  // machine this was built against were exactly this case.
  if (parsed.lastToolErrored && !parsed.lastToolRejectedByUser) return 'failed';

  // done: the transcript rests at a natural stopping point. NOT a success
  // claim -- only that Claude finished a turn without asking for a tool.
  if (parsed.lastStopReason === 'end_turn' && !parsed.endsMidWork) return 'done';

  if (age > STALLED_AFTER_MS) return 'stalled';

  return 'idle';
}

/** Sort order for the root view: attention-worthy statuses first. */
export const STATUS_RANK: Record<Status, number> = {
  running: 0,
  failed: 1,
  idle: 2,
  done: 3,
  stalled: 4,
};
