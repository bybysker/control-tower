import React from 'react';
import { Box, Text } from 'ink';
import type { Project, UserAction } from '../data/types.js';
import { SessionRow } from './SessionRow.js';
import { describeGit } from '../data/project.js';
import {
  actionLocator,
  colorForProject,
  colorForStep,
  columns,
  glyphForProject,
  glyphForStep,
  labelForAction,
  agoLabel,
  timeAgo,
  truncate,
} from '../utils/format.js';

/**
 * A project in full: every action, where we are, the whole plan, PRs, the
 * project's memory notes, then its sessions. Enter on a session opens the
 * transcript; this is the middle of the three levels.
 */

const MAX_NEXT = 8;
const MAX_MEMORY = 6;

interface ProjectViewProps {
  project: Project;
  /** Selected row: actions first, then sessions. See `projectRows`. */
  cursor: number;
  width: number;
  height: number;
  now: Date;
}

/**
 * The ↑↓ list is the actions and then the sessions, in that order, so `⏎` on an
 * action can open the transcript at the turn it is about. `cursor` indexes into
 * that combined list; anything at or past `actions.length` is a session.
 */
export function projectRows(project: Project): number {
  return project.supervision.actions.length + project.sessions.length;
}

/** A question may wrap onto a second line; its options and locator take one each. */
function actionRows(a: UserAction, width: number): number {
  const wrapped = Math.min(2, Math.ceil(columns(a.label) / Math.max(20, width - 14)));
  return wrapped + (a.options && a.options.length > 0 ? 1 : 0) + 1;
}

/** Rows above the session list, so the list can be windowed to what is left. */
export function projectViewFixedRows(project: Project, width: number): number {
  const s = project.supervision;
  return (
    2 + // path/git, blank
    1 + // status line
    (s.actions.length > 0 ? 1 + s.actions.reduce((n, a) => n + actionRows(a, width), 0) : 0) +
    (s.whereWeAre ? 2 : 0) +
    (s.userTasks.length > 0 ? 1 + Math.min(s.userTasks.length, 12) : 0) +
    (s.nextSteps.length > 0 ? 1 + Math.min(s.nextSteps.length, MAX_NEXT) : 0) +
    (s.prLinks.length > 0 ? 1 : 0) +
    (s.memory.length > 0 ? 1 + Math.min(s.memory.length, MAX_MEMORY) : 0) +
    2 // blank + sessions header
  );
}

export function ProjectView({ project, cursor, width, height, now }: ProjectViewProps): React.JSX.Element {
  const s = project.supervision;
  const color = colorForProject(s.status);
  const git = describeGit(s.git);
  const fixed = projectViewFixedRows(project, width);
  // `height` is the frame panel's inner height; one row is kept for the
  // "↓ N more" marker.
  const capacity = Math.max(2, height - fixed - 1);
  // Cursor rows below the actions are session rows; while an action is
  // selected the session list keeps its first page.
  const sessionCursor = cursor - s.actions.length;
  const maxOffset = Math.max(0, project.sessions.length - capacity);
  const offset = Math.min(maxOffset, Math.max(0, sessionCursor - capacity + 1));
  const visible = project.sessions.slice(offset, offset + capacity);
  const hiddenBelow = Math.max(0, project.sessions.length - offset - capacity);
  const rule = (label: string): string => `── ${label} ${'─'.repeat(Math.max(0, width - label.length - 4))}`;

  return (
    <Box flexDirection="column" width={width}>
      <Text dimColor>
        {truncate(project.path, Math.max(20, width - git.length - 6))}
        {git ? `  ·  ${git}` : ''}
      </Text>
      <Text> </Text>
      <Box>
        <Text color={color}>
          {glyphForProject(s.status)} {s.status}
        </Text>
        <Text dimColor>
          {'   '}
          {project.sessions.length} session{project.sessions.length === 1 ? '' : 's'}
          {'   '}last activity {agoLabel(project.lastActivity, now)}
        </Text>
      </Box>

      {s.actions.length > 0 ? (
        <Box flexDirection="column" marginTop={0}>
          <Text color="redBright">{rule(`needs you · ${s.actions.length}`)}</Text>
          {s.actions.map((a, i) => (
            <Box key={`${a.sessionId}-${i}`} flexDirection="column">
              <Box>
                <Text color={i === cursor ? 'cyan' : undefined}>{i === cursor ? '❯ ' : '  '}</Text>
                <Text color="redBright">{labelForAction(a.kind).padEnd(9)}</Text>
                {/* Up to two wrapped lines: the question is the point of the view.
                    Width leaves 6 cells for the age, or it gets clipped to '2'. */}
                <Box width={width - 2 - 9 - 6}>
                  <Text wrap="wrap">{truncate(a.label, 2 * (width - 17))}</Text>
                </Box>
                <Text dimColor> {timeAgo(a.since, now).padStart(4)}</Text>
              </Box>
              {a.options && a.options.length > 0 ? (
                <Text color="yellow">
                  {' '.repeat(11)}
                  {truncate(a.options.map((o) => `[${o}]`).join('  '), width - 12)}
                </Text>
              ) : null}
              {/* Which window to go to, and — with ⏎ — where to look once there. */}
              <Text dimColor>
                {' '.repeat(11)}
                {truncate(`↳ ${actionLocator(a, now)}`, width - 12)}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}

      {s.whereWeAre ? (
        <Box flexDirection="column">
          <Text dimColor>{rule(`where we are · ${agoLabel(s.whereWeAre.at, now)}`)}</Text>
          <Text>{truncate(s.whereWeAre.text, width - 2)}</Text>
        </Box>
      ) : null}

      {s.userTasks.length > 0 ? (
        <Box flexDirection="column">
          <Text color="yellow">{rule(`your turn · ${s.userTasks.length}`)}</Text>
          {s.userTasks.slice(0, 12).map((t) => (
            <Box key={t.id}>
              <Text color={t.blocking ? '#FF7B7B' : 'yellow'}>{t.blocking ? '▲ ' : '△ '}</Text>
              <Text>{truncate(t.label, width - 4 - (t.where ? t.where.length + 2 : 0))}</Text>
              {t.where ? <Text dimColor>  {t.where}</Text> : null}
            </Box>
          ))}
        </Box>
      ) : null}

      {s.nextSteps.length > 0 ? (
        <Box flexDirection="column">
          <Text dimColor>{rule(`next · ${s.nextSteps.length}`)}</Text>
          {s.nextSteps.slice(0, MAX_NEXT).map((n) => (
            <Box key={n.id}>
              <Text color={colorForStep(n)}>{glyphForStep(n)} </Text>
              <Text color={n.status === 'in_progress' ? 'yellow' : undefined}>
                {truncate(n.label, width - 4)}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}

      {s.prLinks.length > 0 ? (
        <Text dimColor>
          {truncate(
            'PR  ' + s.prLinks.map((pr) => `#${pr.number} ${pr.url}`).join('   '),
            width - 2,
          )}
        </Text>
      ) : null}

      {s.memory.length > 0 ? (
        <Box flexDirection="column">
          <Text dimColor>{rule('memory')}</Text>
          {s.memory.slice(0, MAX_MEMORY).map((m, i) => (
            <Text key={i} dimColor>
              {truncate(`· ${m}`, width - 2)}
            </Text>
          ))}
        </Box>
      ) : null}

      <Text> </Text>
      <Text dimColor>
        {rule(
          `sessions · ${offset + 1}-${Math.min(offset + capacity, project.sessions.length)} of ${project.sessions.length}`,
        )}
      </Text>
      {visible.map((session, i) => (
        <SessionRow
          key={session.filePath}
          session={session}
          selected={offset + i === sessionCursor}
          width={width}
          now={now}
        />
      ))}
      {hiddenBelow > 0 ? <Text dimColor>  ↓ {hiddenBelow} more</Text> : null}
    </Box>
  );
}
