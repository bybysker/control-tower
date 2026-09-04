import React from 'react';
import { Box, Text } from 'ink';
import type { Session, Turn } from '../data/types.js';
import { Line, wrapText } from './Line.js';
import { planProgress, taskLabel } from '../data/plan.js';
import {
  colorForStatus,
  colorForTask,
  columns,
  glyphForStatus,
  glyphForTask,
  agoLabel,
  truncate,
} from '../utils/format.js';

interface SessionDetailProps {
  session: Session;
  /** First visible transcript line -- the scroll offset. */
  scroll: number;
  width: number;
  height: number;
  now: Date;
  /** Index into `session.turns` the view was opened at, from a NEEDS YOU action. */
  focus?: number;
}

/** Most wrapped lines the focus block gives the turn's own text. */
const FOCUS_TEXT_LINES = 4;
/** Columns the block indents its text by, under the `call` label. */
const FOCUS_INDENT = 8;
/** Transcript lines that must survive the block, or it is not worth its rows. */
const FOCUS_MIN_TRANSCRIPT = 12;

/**
 * The focused turn's text, wrapped -- the whole reason for the block, since the
 * transcript below truncates every turn to one row.
 *
 * One function, called by both the renderer and the row budget: they have to
 * agree on the line count exactly, and the only way to be sure is to ask the
 * same question once.
 */
function focusBody(turn: Turn, width: number): string[] {
  const lines = wrapText(turn.text, Math.max(10, width - FOCUS_INDENT), FOCUS_TEXT_LINES);
  return lines.length > 0 ? lines : [''];
}

/**
 * Rows the focus block costs -- 0 when there is nothing to focus, or when the
 * panel is too short to pay for it and still show a usable transcript.
 *
 * `transcriptCapacity` and the render below must agree exactly, or the view
 * grows past its height and Ink clear-screens instead of repainting.
 */
export function focusBlockRows(session: Session, height: number, width: number, focus?: number): number {
  if (focus === undefined || focus < 0) return 0;
  const turn = session.turns[focus];
  if (!turn) return 0;
  const rows = 3 + focusBody(turn, width).length; // blank, heading, call, text
  return height - rows >= FOCUS_MIN_TRANSCRIPT ? rows : 0;
}

const ROLE_LABEL: Record<Turn['role'], string> = {
  user: 'user',
  assistant: 'assistant',
  tool_use: 'tool_use',
  tool_result: 'result',
  system: 'system',
};

function roleColor(turn: Turn): string | undefined {
  if (turn.role === 'user') return 'cyan';
  if (turn.role === 'assistant') return 'white';
  if (turn.role === 'tool_use') return 'blue';
  if (turn.role === 'tool_result') return turn.isError ? 'red' : 'gray';
  return 'gray';
}

/**
 * How many transcript lines fit, given the plan block above them.
 *
 * Exported because App needs the same number to clamp scrolling: without it,
 * maxScroll is computed from the turn count alone and the newest turns sit
 * below the fold, unreachable.
 */
export function transcriptCapacity(session: Session, height: number, width = 0, focus?: number): number {
  // The "no plan recorded" line costs the same two rows (margin + text) as a
  // plan header does, so an empty plan is not zero lines.
  const planLines = session.plan.tasks.length > 0 ? session.plan.tasks.length + 2 : 2;
  // `height` is the inner height of the frame panel this renders in. Fixed
  // rows here: cwd, blank, status, version, blank, plan header, blank,
  // transcript header = 8 = planLines(2) + 6.
  return Math.max(3, height - planLines - 6 - focusBlockRows(session, height, width, focus));
}

export function SessionDetail({
  session,
  scroll,
  width,
  height,
  now,
  focus,
}: SessionDetailProps): React.JSX.Element {
  const { plan } = session;
  const progress = planProgress(plan);
  // Header + plan block take a variable slice; give the transcript the rest.
  const transcriptHeight = transcriptCapacity(session, height, width, focus);
  const focusRows = focusBlockRows(session, height, width, focus);
  const visible = session.turns.slice(scroll, scroll + transcriptHeight);
  const roleW = 11;

  return (
    <Box flexDirection="column" width={width}>
      <Box>
        <Text dimColor>{session.cwd ?? '—'}</Text>
        {session.gitBranch ? <Text dimColor> · {session.gitBranch}</Text> : null}
      </Box>

      <Box marginTop={1}>
        <Text color={colorForStatus(session.status)}>
          {glyphForStatus(session.status)} {session.status}
        </Text>
        <Text dimColor>
          {'   '}
          started {session.firstTimestamp ? agoLabel(session.firstTimestamp, now) : '—'}
          {'   '}
          turns {session.turnCount}
          {'   '}
          last event {agoLabel(session.lastActivity, now)}
        </Text>
      </Box>
      {session.version || session.entrypoint ? (
        <Box>
          <Text dimColor>
            {session.entrypoint ?? '—'} · v{session.version ?? '—'} · {session.sessionId.slice(0, 8)}
          </Text>
        </Box>
      ) : null}

      {plan.tasks.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            ── current plan ({plan.source}) · {progress.completed}/{progress.total} done ─────
          </Text>
          {plan.tasks.map((task) => (
            <Box key={task.id}>
              <Text color={colorForTask(task.status)}>{glyphForTask(task.status)} </Text>
              <Text
                color={task.status === 'in_progress' ? 'yellow' : undefined}
                dimColor={task.status === 'completed'}
              >
                {truncate(taskLabel(task), Math.max(20, width - 4))}
              </Text>
            </Box>
          ))}
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>── no plan recorded (no TaskCreate or TodoWrite in this session) ──</Text>
        </Box>
      )}

      {focusRows > 0 && focus !== undefined ? (
        <FocusBlock session={session} focus={focus} width={width} />
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>
          ── transcript ({session.turns.length === 0
            ? 'empty'
            : `${scroll + 1}-${Math.min(scroll + transcriptHeight, session.turns.length)} of ${session.turns.length}`}
          ) ─────
        </Text>
        {visible.map((turn, i) => (
          <Box key={`${scroll + i}`}>
            <Text color={roleColor(turn)}>
              [{ROLE_LABEL[turn.role]}]{' '.repeat(Math.max(1, roleW - ROLE_LABEL[turn.role].length))}
            </Text>
            <Text dimColor={turn.role === 'tool_result'}>
              {truncate(turn.text, Math.max(10, width - roleW - 3))}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/** What the heading says depends on what kind of turn we were sent to. */
function focusHeading(turn: Turn): string {
  if (turn.role === 'tool_result') return turn.isError ? 'what failed' : 'what came back';
  if (turn.role === 'tool_use') return 'what it is waiting on';
  return 'where this points';
}

/**
 * The turn a NEEDS YOU action pointed at, quoted in full at the top of the view.
 *
 * The transcript truncates every turn to one row, which is exactly the reading
 * an error message survives worst. This block spends a fixed six rows -- see
 * `FOCUS_ROWS`, which `transcriptCapacity` subtracts -- on the call and the
 * first `FOCUS_TEXT_LINES` wrapped lines of its text. The turn is still in the
 * transcript below; this is a quotation, not a replacement.
 */
function FocusBlock({ session, focus, width }: { session: Session; focus: number; width: number }): React.JSX.Element {
  const turn = session.turns[focus];
  if (!turn) return <Box />;
  // A result says nothing about which command produced it: the call is the
  // nearest tool_use above it.
  const call =
    turn.role === 'tool_result'
      ? session.turns.slice(0, focus).reverse().find((t) => t.role === 'tool_use')
      : undefined;
  const callText = call ? call.text : (turn.toolName ?? ROLE_LABEL[turn.role]);
  const heading = `── ${focusHeading(turn)} `;
  // The rule is repeated to exactly the width left: one column over and Line
  // would clip it to an ellipsis instead of a rule.
  const fill = Math.max(0, width - columns(heading));

  return (
    <Box flexDirection="column" marginTop={1}>
      <Line
        width={width}
        segs={[{ t: heading, color: turn.isError ? 'red' : 'gray' }, { t: '─'.repeat(fill), dim: true, flex: true }]}
      />
      <Line width={width} segs={[{ t: 'call'.padEnd(FOCUS_INDENT), dim: true }, { t: callText, flex: true }]} />
      {focusBody(turn, width).map((l, i) => (
        <Line
          key={i}
          width={width}
          segs={[{ t: ' '.repeat(FOCUS_INDENT) }, { t: l, color: turn.isError ? 'red' : undefined, flex: true }]}
        />
      ))}
    </Box>
  );
}
