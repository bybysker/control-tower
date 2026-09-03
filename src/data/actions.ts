import type { Session, UserAction } from './types.js';
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
 */
export function deriveActions(session: Session, now: Date = new Date()): UserAction[] {
  const out: UserAction[] = [];
  const base = { sessionId: session.sessionId, sessionTitle: session.title, since: session.lastActivity };
  const age = now.getTime() - session.lastActivity.getTime();

  if (session.pendingQuestion) {
    out.push({
      ...base,
      kind: 'answer',
      label: session.pendingQuestion.question,
      options: session.pendingQuestion.options,
    });
    return out; // the question IS the ask; nothing else applies
  }

  if (session.status === 'failed') {
    const last = [...session.turns].reverse().find((t) => t.role === 'tool_result' && t.isError);
    out.push({ ...base, kind: 'failed', label: last ? truncate(last.text, 120) : 'last tool call failed' });
    return out;
  }

  if (session.pendingToolName && age >= RUNNING_WINDOW_MS && !session.lastToolRejectedByUser) {
    out.push({
      ...base,
      kind: 'permission',
      label: `${session.pendingToolName} is waiting for a result -- permission prompt, or the process died`,
    });
    return out;
  }

  const text = session.lastAssistantText?.trim();
  if (text && text.endsWith('?') && !session.endsMidWork) {
    out.push({ ...base, kind: 'reply', label: lastSentence(text) });
  }
  return out;
}

/** The trailing question, so the card shows the ask and not the preamble. */
function lastSentence(text: string): string {
  const parts = text.split(/(?<=[.!?])\s+/);
  const tail = parts[parts.length - 1] ?? text;
  return truncate(tail, 160);
}
