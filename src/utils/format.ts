import { formatDistanceStrict } from 'date-fns';
import stringWidth from 'string-width';
import type { ActionKind, NextStep, ProjectStatus, Status, TaskStatus, UserAction } from '../data/types.js';

/** "2s", "4h", "3d" -- compact enough for a fixed-width column. */
export function timeAgo(date: Date, now: Date = new Date()): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
  const deltaMs = now.getTime() - date.getTime();
  // date-fns rounds 0-999ms up to "1 second"; "now" reads better in a live TUI.
  if (deltaMs >= 0 && deltaMs < 1000) return 'now';
  // formatDistanceStrict against the injected `now`, not *ToNowStrict: the
  // latter reads the wall clock and silently ignores the caller's reference
  // time, which made the snapshot and the tests lie.
  const raw = formatDistanceStrict(date, now, { addSuffix: false });
  return raw
    .replace(/ seconds?$/, 's')
    .replace(/ minutes?$/, 'm')
    .replace(/ hours?$/, 'h')
    .replace(/ days?$/, 'd')
    .replace(/ months?$/, 'mo')
    .replace(/ years?$/, 'y');
}

/**
 * Truncate to `max` terminal COLUMNS, with a single-char ellipsis.
 *
 * Measured with string-width, not .length: an emoji in a session title is one
 * code unit wide in JS and two columns wide on screen, and a column layout
 * built on .length drifts by one for every such character.
 */
export function truncate(text: string, max: number): string {
  const flat = sanitizeWidth(text.replace(/\s+/g, ' ').trim());
  if (max <= 0) return '';
  if (stringWidth(flat) <= max) return flat;
  if (max === 1) return '…';
  let out = '';
  let width = 0;
  for (const char of flat) {
    const w = stringWidth(char);
    if (width + w > max - 1) break;
    out += char;
    width += w;
  }
  return out + '…';
}

/**
 * Truncate from the LEFT, keeping the tail: `…/scratchpad/demo-store`.
 *
 * For a path the tail is the informative half -- `/private/tmp/cl…` says
 * nothing, while the last two segments say where you are.
 */
export function truncateStart(text: string, max: number): string {
  const flat = sanitizeWidth(text.replace(/\s+/g, ' ').trim());
  if (max <= 0) return '';
  if (stringWidth(flat) <= max) return flat;
  if (max === 1) return '…';
  const chars = [...flat];
  let out = '';
  let width = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i];
    if (ch === undefined) break;
    const w = stringWidth(ch);
    if (width + w > max - 1) break;
    out = ch + out;
    width += w;
  }
  return '…' + out;
}

/** Pad or truncate to exactly `width` columns. */
export function fit(text: string, width: number): string {
  const t = truncate(text, width);
  return t + ' '.repeat(Math.max(0, width - stringWidth(t)));
}

/** Column width of a string as the terminal will draw it. */
export const columns = stringWidth;

/**
 * Replace every double-width character (emoji, CJK) with `·` and drop
 * zero-width ones. Ink measures wide characters at two cells but writes them
 * with one cell too many, which pushes a row one column past the frame and,
 * once the terminal wraps it, shears every row below. A transcript emoji is
 * not worth a broken frame, so no text reaches the screen un-sanitised.
 */
export function sanitizeWidth(text: string): string {
  let out = '';
  for (const ch of text) {
    const w = stringWidth(ch);
    if (w === 0) continue;
    out += w >= 2 ? '·' : ch;
  }
  return out;
}

export type InkColor = 'yellow' | 'gray' | 'green' | 'red' | 'magenta' | 'redBright' | 'cyan';

export function colorForStatus(status: Status): InkColor {
  switch (status) {
    case 'running':
      return 'yellow';
    case 'done':
      return 'green';
    case 'failed':
      return 'red';
    case 'stalled':
      return 'magenta';
    case 'idle':
    default:
      return 'gray';
  }
}

export function glyphForStatus(status: Status): string {
  switch (status) {
    case 'running':
      return '●';
    case 'done':
      return '✓';
    case 'failed':
      return '✗';
    case 'stalled':
      return '…';
    case 'idle':
    default:
      return '○';
  }
}

export function glyphForTask(status: TaskStatus): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'in_progress':
      return '●';
    case 'pending':
    default:
      return '○';
  }
}

export function colorForTask(status: TaskStatus): InkColor {
  switch (status) {
    case 'completed':
      return 'green';
    case 'in_progress':
      return 'yellow';
    case 'pending':
    default:
      return 'gray';
  }
}

/** Project status shares the session palette; `action` is the loud one. */
export function colorForProject(status: ProjectStatus): InkColor {
  return status === 'action' ? 'redBright' : colorForStatus(status);
}

export function glyphForProject(status: ProjectStatus): string {
  return status === 'action' ? '!' : glyphForStatus(status);
}

/** Short verb for an action row: what the human has to do. */
export function labelForAction(kind: ActionKind): string {
  switch (kind) {
    case 'answer':
      return 'answer';
    case 'failed':
      return 'fix';
    case 'permission':
      return 'unblock';
    case 'reply':
    default:
      return 'reply';
  }
}

/**
 * The line under a NEEDS YOU row: which session, so you know which window.
 *
 * Title, entrypoint, when it started, working directory, short id -- every one
 * a fact the transcript recorded about itself. It says where the session was
 * started, never that anything is still alive there: for `answer`, `reply` and
 * `unblock` the process is somewhere we cannot see, and this line must not read
 * as evidence to the contrary.
 */
export function actionLocator(a: UserAction, now: Date = new Date()): string {
  const parts: string[] = [];
  const title = truncate(a.sessionTitle ?? '', 32);
  if (title) parts.push(title);
  if (a.entrypoint) parts.push(a.entrypoint);
  if (a.startedAt) parts.push(`started ${agoLabel(a.startedAt, now)}`);
  // The tail of a path is the informative half: `…/bootcamp/api` locates you,
  // `/Users/someone/Dev…` does not.
  if (a.cwd) parts.push(truncateStart(a.cwd, 34));
  parts.push(`#${a.sessionId.slice(0, 8)}`);
  return parts.join(' · ');
}

/** "now", or "12s ago" -- never "now ago". */
export function agoLabel(date: Date, now: Date = new Date()): string {
  const t = timeAgo(date, now);
  return t === 'now' || t === '—' ? t : `${t} ago`;
}

/**
 * A next step is glyphed by its source, because they differ in certainty:
 * a plan step is what Claude said it would do, a git step is mechanical fact,
 * an AI step is a guess.
 */
export function glyphForStep(step: NextStep): string {
  if (step.source === 'plan') return glyphForTask(step.status ?? 'pending');
  return step.source === 'git' ? '→' : '∴';
}

export function colorForStep(step: NextStep): InkColor | undefined {
  if (step.source === 'plan') return colorForTask(step.status ?? 'pending');
  return step.source === 'git' ? 'cyan' : 'yellow';
}
