import React from 'react';
import { Box, Text } from 'ink';
import type { Session, Turn } from '../data/types.js';
import { planProgress, taskLabel } from '../data/plan.js';
import {
  colorForStatus,
  colorForTask,
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
export function transcriptCapacity(session: Session, height: number): number {
  // The "no plan recorded" line costs the same two rows (margin + text) as a
  // plan header does, so an empty plan is not zero lines.
  const planLines = session.plan.tasks.length > 0 ? session.plan.tasks.length + 2 : 2;
  // `height` is the inner height of the frame panel this renders in. Fixed
  // rows here: cwd, blank, status, version, blank, plan header, blank,
  // transcript header = 8 = planLines(2) + 6.
  return Math.max(3, height - planLines - 6);
}

export function SessionDetail({
  session,
  scroll,
  width,
  height,
  now,
}: SessionDetailProps): React.JSX.Element {
  const { plan } = session;
  const progress = planProgress(plan);
  // Header + plan block take a variable slice; give the transcript the rest.
  const transcriptHeight = transcriptCapacity(session, height);
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
