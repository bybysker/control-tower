import type { Session, Turn, UserAction } from './types.js';
import { RUNNING_WINDOW_MS } from './status.js';
import { truncate } from '../utils/format.js';

/**
 * What the human owes a session.
 *
 * These are the situations that status.ts lists as its own failure modes -- a
 * session blocked on a permission prompt looks like it is running; a session
 * that asked a question looks done. Read from the project's side they are not
 * noise, they are the point: nothing moves until someone answers.
 *
 * Certainty, high to low:
 *   answer      an AskUserQuestion with no result. Unambiguous.
 *   failed      the last tool call errored (and it was not the user saying no).
 *   permission  a tool call still unanswered past the running window. Usually a
 *               permission prompt; can also be a crashed process. We say so.
 *   reply       Claude's last words end in '?', and nothing is pending.
 *
 * Each action also carries where to go (`entrypoint`, `startedAt`, `cwd`) and
 * which turn it is about (`turnIndex`), so the card can point at the window and
 * at the text instead of leaving both to be hunted for. Pointing is all it is:
 * three of the four kinds are a live process in another terminal, and nothing
 * we can read says whether it is still there.
 */
export function deriveActions(session: Session, now: Date = new Date()): UserAction[] {
  const out: UserAction[] = [];
  const base = {
    sessionId: session.sessionId,
    sessionTitle: session.title,
    since: session.lastActivity,
    // Which window to go to. Copied, not deduced: every field is something the
    // transcript wrote down about itself.
    entrypoint: session.entrypoint,
    startedAt: session.firstTimestamp,
    cwd: session.cwd,
  };
  const age = now.getTime() - session.lastActivity.getTime();

  if (session.pendingQuestion) {
    out.push({
      ...base,
      kind: 'answer',
      label: session.pendingQuestion.question,
      options: session.pendingQuestion.options,
      turnIndex: lastIndex(session, (t) => t.role === 'tool_use' && t.toolName === 'AskUserQuestion'),
    });
    return out; // the question IS the ask; nothing else applies
  }

  if (session.status === 'failed') {
    const at = lastIndex(session, (t) => t.role === 'tool_result' && t.isError === true);
    const last = at === undefined ? undefined : session.turns[at];
    out.push({
      ...base,
      kind: 'failed',
      label: last ? truncate(last.text, 120) : 'last tool call failed',
      turnIndex: at,
    });
    return out;
  }

  if (session.pendingToolName && age >= RUNNING_WINDOW_MS && !session.lastToolRejectedByUser) {
    out.push({
      ...base,
      kind: 'permission',
      label: `${session.pendingToolName} is waiting for a result -- permission prompt, or the process died`,
      turnIndex: lastIndex(session, (t) => t.role === 'tool_use' && t.toolName === session.pendingToolName),
    });
    return out;
  }

  const text = session.lastAssistantText?.trim();
  if (text && text.endsWith('?') && !session.endsMidWork) {
    out.push({
      ...base,
      kind: 'reply',
      label: lastSentence(text),
      turnIndex: lastIndex(session, (t) => t.role === 'assistant'),
    });
  }
  return out;
}

/**
 * Index of the last turn matching `pred`, or undefined.
 *
 * Undefined is the normal case for an old session, not an error: `turns` holds
 * only the tail, so the turn an action points at may have been trimmed away.
 */
function lastIndex(session: Session, pred: (t: Turn) => boolean): number | undefined {
  for (let i = session.turns.length - 1; i >= 0; i--) {
    const turn = session.turns[i];
    if (turn && pred(turn)) return i;
  }
  return undefined;
}

/** The trailing question, so the card shows the ask and not the preamble. */
function lastSentence(text: string): string {
  const parts = text.split(/(?<=[.!?])\s+/);
  const tail = parts[parts.length - 1] ?? text;
  return truncate(tail, 160);
}
