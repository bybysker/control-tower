import React from 'react';
import { Box, Text } from 'ink';
import type { Project, Session, Turn } from '../data/types.js';
import type { SummaryState } from '../data/summarize.js';
import { describeGit } from '../data/project.js';
import { planProgress } from '../data/plan.js';
import { ACCENT, CHECK, FooterBar, HeaderBar, type KeyHint, Panel, Rule, RULE, SELECT_BG } from './Frame.js';
import { Line, type Seg, wrapText } from './Line.js';
import {
  actionLocator,
  colorForProject,
  colorForStatus,
  colorForStep,
  glyphForProject,
  glyphForStatus,
  glyphForStep,
  labelForAction,
  agoLabel,
  timeAgo,
  truncate,
} from '../utils/format.js';

/**
 * The root view: one framed dashboard, everything visible at once.
 *
 *   ┌ header: identity · metrics / status · progress ┐
 *   ├ Active Project ──────────┬ Projects ───────────┤
 *   │ needs you / where we are │ (selection)         │
 *   │ next / memory            ├ Activity ───────────┤
 *   │                          │ latest events       │
 *   ├ Latest Session ──────────┴─────────────────────┤
 *   │ execute / read / … stream                      │
 *   ├ keys ──────────────────────────────────────────┤
 *
 * ↑↓ move the selection in Projects; the other three panels follow it.
 */

export interface DashboardProps {
  claudeHome: string;
  /** Projects after filtering, in display order. */
  projects: Project[];
  /** Every project, for the header metrics. */
  allProjects: Project[];
  selected: number;
  width: number;
  height: number;
  now: Date;
  filter?: { value: string; active: boolean; matches: number };
  note?: string;
  error?: string;
  /** --ai is on: the `A` key is live and summary state is worth showing. */
  ai?: boolean;
  summary?: SummaryState;
  /** Changes whenever a summary starts or settles, so the panel re-renders. */
  summaryTick?: number;
}

export const ROOT_KEYS: KeyHint[] = [
  { key: '↑↓', label: 'Projects' },
  { key: '⏎', label: 'Open' },
  { key: '/', label: 'Filter' },
  { key: 'R', label: 'Refresh' },
  { key: 'Q', label: 'Quit' },
];

/** With --ai, the `A` key is offered between Filter and Refresh. */
function rootKeys(ai: boolean): KeyHint[] {
  if (!ai) return ROOT_KEYS;
  const keys = [...ROOT_KEYS];
  keys.splice(3, 0, { key: 'A', label: 'Next steps' });
  return keys;
}

/** Height of the bottom (session) panel for a given terminal height. */
export function bottomPanelHeight(height: number): number {
  return height >= 40 ? 9 : height >= 30 ? 7 : 5;
}

export function Dashboard(p: DashboardProps): React.JSX.Element {
  const { width: W, height: H, now } = p;
  const K = bottomPanelHeight(H);
  // top rule 1 + header 2 + rule 1 + middle M + rule 1 + bottom K + rule 1 + footer 1 + bottom rule 1 = H - 1
  const M = Math.max(6, H - 9 - K);
  const leftW = Math.floor((W - 3) * 0.55);
  const rightW = W - 3 - leftW;
  const h1 = Math.max(4, Math.ceil(M * 0.5));
  const h2 = Math.max(3, M - h1 - 1);

  const project = p.projects[Math.min(p.selected, Math.max(0, p.projects.length - 1))];
  const sessions = p.allProjects.reduce((n, x) => n + x.sessions.length, 0);
  const needs = p.allProjects.reduce(
    (n, x) => n + x.supervision.actions.length + x.supervision.userTasks.filter((t) => t.blocking).length,
    0,
  );
  const running = p.allProjects.reduce((n, x) => n + x.sessions.filter((s) => s.status === 'running').length, 0);

  const status = needs > 0 ? 'NEEDS YOU' : running > 0 ? 'RUNNING' : sessions > 0 ? 'IDLE' : 'EMPTY';
  const statusColor = needs > 0 ? '#FF7B7B' : running > 0 ? ACCENT : 'gray';
  const progress = progressOf(project);

  return (
    <Box flexDirection="column" width={W}>
      <Rule width={W} edge="top" />
      <HeaderBar
        width={W}
        path={p.claudeHome}
        metrics={[
          { label: 'Projects', value: String(p.allProjects.length) },
          { label: 'Sessions', value: String(sessions) },
          { label: 'Needs you', value: String(needs) },
          { label: 'Running', value: String(running) },
        ]}
        status={status}
        statusColor={statusColor}
        progress={progress.ratio}
        progressLabel={progress.label}
        filter={p.filter}
      />
      <Rule width={W} edge="middle" split={leftW} splitKind="down" />
      <Box flexDirection="row" height={M}>
        <Panel width={leftW + 1} height={M} edges="left" title="Active Project" subtitle={project?.label ?? '—'}>
          {project ? (
            <ActiveProject project={project} width={leftW - 2} rows={M - 2} now={now} summary={p.summary} />
          ) : (
            <Text dimColor>No project selected</Text>
          )}
        </Panel>
        <Box flexDirection="column" width={rightW + 2}>
          <Panel width={rightW + 2} height={h1} title="Projects" meta={`${p.projects.length}${p.projects.length !== p.allProjects.length ? `/${p.allProjects.length}` : ''}`}>
            <ProjectList projects={p.projects} selected={p.selected} rows={h1 - 2} width={rightW - 2} now={now} />
          </Panel>
          <Text color={RULE}>{'├' + '─'.repeat(rightW) + '┤'}</Text>
          <Panel width={rightW + 2} height={h2} title="Activity" meta={activityMeta(p.allProjects, h2 - 2)}>
            <Activity projects={p.allProjects} rows={h2 - 2} width={rightW - 2} now={now} />
          </Panel>
        </Box>
      </Box>
      <Rule width={W} edge="middle" split={leftW} splitKind="up" />
      <LatestSession project={project} width={W} height={K} now={now} />
      <Rule width={W} edge="middle" />
      <FooterBar width={W} keys={rootKeys(p.ai ?? false)} note={p.note} error={p.error} />
      <Rule width={W} edge="bottom" />
    </Box>
  );
}

function progressOf(project: Project | undefined): { ratio: number; label: string } {
  if (!project) return { ratio: 0, label: '0/0' };
  const planned = project.sessions.find((s) => s.plan.tasks.length > 0);
  if (planned) {
    const { completed, total } = planProgress(planned.plan);
    return { ratio: total ? completed / total : 0, label: `${completed}/${total}` };
  }
  const done = project.sessions.filter((s) => s.status === 'done').length;
  return { ratio: project.sessions.length ? done / project.sessions.length : 0, label: `${done}/${project.sessions.length}` };
}

// ---------------------------------------------------------------------------

/**
 * Rows are sliced to the panel height HERE rather than left to the panel's
 * overflow clipping: Ink's clip path mis-renders rows adjacent to a blank one
 * (first character lost, blank dropped) when content is taller than the box.
 */
function ActiveProject({ project, width, rows: maxRows, now, summary }: { project: Project; width: number; rows: number; now: Date; summary?: SummaryState }): React.JSX.Element {
  const s = project.supervision;
  const rows: React.ReactNode[] = [];
  const blank = (key: string): void => {
    rows.push(<Line key={key} width={width} segs={[]} />);
  };
  const kv = (k: string, v: Seg[]): void => {
    rows.push(<Line key={`kv-${k}`} width={width} segs={[{ t: k.padEnd(8), dim: true }, ...v]} />);
  };
  const heading = (t: string, meta?: string): void => {
    blank(`h-${t}`);
    rows.push(<Line key={`hh-${t}`} width={width} segs={[{ t, bold: true }, ...(meta ? [{ t: '  ' + meta, dim: true }] : [])]} />);
  };
  const quote = (text: string, max: number, key: string): void => {
    wrapText(text, width - 2, max).forEach((l, i) =>
      rows.push(<Line key={`${key}-${i}`} width={width} segs={[{ t: '┃ ', color: RULE }, { t: l, dim: true }]} />),
    );
  };

  const git = describeGit(s.git);
  kv('status', [{ t: `${glyphForProject(s.status)} ${s.status}`, color: colorForProject(s.status) }, { t: `   ${project.sessions.length} session${project.sessions.length === 1 ? '' : 's'} · ${agoLabel(project.lastActivity, now)}`, dim: true }]);
  if (git) kv('git', [{ t: git }]);
  kv('path', [{ t: project.path, dim: true }]);
  if (s.prLinks.length > 0) kv('PR', [{ t: s.prLinks.map((x) => `#${x.number}`).join(' '), color: ACCENT }, { t: '  ' + (s.prLinks[0]?.url ?? ''), dim: true }]);

  if (s.actions.length > 0) {
    heading('Needs you', String(s.actions.length));
    for (const a of s.actions) {
      rows.push(
        <Line key={`a-${a.sessionId}-${a.kind}`} width={width} segs={[{ t: '  ' }, { t: labelForAction(a.kind).padEnd(9), color: '#FF7B7B', bold: true }, { t: a.label, flex: true }, { t: ' ' + timeAgo(a.since, now), dim: true }]} />,
      );
      if (a.options && a.options.length > 0) {
        rows.push(<Line key={`ao-${a.sessionId}`} width={width} segs={[{ t: '           ' }, { t: a.options.map((o) => `[${o}]`).join('  '), color: 'yellow' }]} />);
      }
      // Which window to switch to. Without it the card names a symptom and
      // leaves the hunt for the session to the reader.
      rows.push(
        <Line
          key={`al-${a.sessionId}-${a.kind}`}
          width={width}
          segs={[{ t: '           ' }, { t: '↳ ', color: RULE }, { t: actionLocator(a, now), dim: true, flex: true }]}
        />,
      );
    }
  }

  if (s.whereWeAre) {
    heading('Where we are', agoLabel(s.whereWeAre.at, now));
    quote(s.whereWeAre.text, 4, 'w');
  }

  if (s.userTasks.length > 0) {
    const blocking = s.userTasks.filter((t) => t.blocking).length;
    heading('Your turn', blocking > 0 ? `${s.userTasks.length} · ${blocking} blocking` : String(s.userTasks.length));
    for (const t of s.userTasks.slice(0, 6)) {
      rows.push(
        <Line
          key={`ut-${t.id}`}
          width={width}
          segs={[
            { t: '  ' },
            { t: t.blocking ? '▲ ' : '△ ', color: t.blocking ? '#FF7B7B' : 'yellow' },
            { t: t.label, color: t.blocking ? undefined : 'yellow' },
            ...(t.where ? [{ t: `  ${t.where}`, dim: true }] : []),
          ]}
        />,
      );
    }
    if (s.userTasks.length > 6) {
      rows.push(
        <Line key="ut-more" width={width} segs={[{ t: `    … ${s.userTasks.length - 6} more`, dim: true }]} />,
      );
    }
  }

  if (s.nextSteps.length > 0 || summary?.kind === 'running' || summary?.kind === 'error') {
    heading('Next', s.nextSteps.length > 0 ? String(s.nextSteps.length) : '');
    s.nextSteps.slice(0, 6).forEach((n) =>
      rows.push(
        <Line
          key={`n-${n.id}`}
          width={width}
          segs={[
            { t: '  ' },
            { t: glyphForStep(n) + ' ', color: colorForStep(n) },
            { t: n.label, color: n.status === 'in_progress' ? 'yellow' : undefined },
          ]}
        />,
      ),
    );
  }

  if (summary?.kind === 'running') {
    rows.push(<Line key="ai-run" width={width} segs={[{ t: '  ∴ ', color: ACCENT }, { t: 'asking Claude…', dim: true }]} />);
  } else if (summary?.kind === 'error') {
    rows.push(<Line key="ai-err" width={width} segs={[{ t: '  ∴ ', color: 'red' }, { t: summary.message, dim: true }]} />);
  }

  if (s.memory.length > 0) {
    heading('Memory');
    s.memory.slice(0, 5).forEach((m, i) => rows.push(<Line key={`m-${i}`} width={width} segs={[{ t: '┃ ', color: RULE }, { t: m, dim: true }]} />));
  }

  const shown = rows.slice(0, Math.max(0, maxRows));
  if (rows.length > shown.length && shown.length > 0) {
    shown[shown.length - 1] = <Line key="more" width={width} segs={[{ t: `  … ${rows.length - shown.length + 1} more lines — ⏎ to open`, dim: true }]} />;
  }
  return <Box flexDirection="column">{shown}</Box>;
}

// ---------------------------------------------------------------------------

function ProjectList({ projects, selected, rows, width, now }: { projects: Project[]; selected: number; rows: number; width: number; now: Date }): React.JSX.Element {
  const cap = Math.max(1, rows);
  let offset = 0;
  if (selected >= cap) offset = selected - cap + 1;
  const visible = projects.slice(offset, offset + cap);
  const below = projects.length - offset - cap;
  return (
    <Box flexDirection="column">
      {visible.map((pr, i) => {
        const idx = offset + i;
        const sel = idx === selected;
        const s = pr.supervision;
        const git = describeGit(s.git);
        const pr0 = s.prLinks[0];
        const meta = [git, pr0 ? `PR #${pr0.number}` : ''].filter(Boolean).join(' · ');
        const isLastAndMore = i === visible.length - 1 && below > 0 && !sel;
        if (isLastAndMore) return <Line key="more" width={width} segs={[{ t: `  ↓ ${below + 1} more`, dim: true }]} />;
        return (
          <Line
            key={pr.dir}
            width={width}
            bg={sel ? SELECT_BG : undefined}
            fg={sel ? 'black' : undefined}
            segs={[
              { t: glyphForProject(s.status) + ' ', color: colorForProject(s.status) },
              { t: truncate(pr.label, 22).padEnd(22) },
              { t: ' ' + meta, dim: true, flex: true },
              { t: ' ' + timeAgo(pr.lastActivity, now).padStart(4), dim: true },
            ]}
          />
        );
      })}
    </Box>
  );
}

// ---------------------------------------------------------------------------

function recentSessions(projects: Project[]): Array<{ project: Project; session: Session }> {
  return projects
    .flatMap((project) => project.sessions.map((session) => ({ project, session })))
    .sort((a, b) => b.session.lastActivity.getTime() - a.session.lastActivity.getTime());
}

function activityMeta(projects: Project[], rows: number): string {
  const total = projects.reduce((n, x) => n + x.sessions.length, 0);
  return total === 0 ? '0' : `1-${Math.min(rows, total)} of ${total}`;
}

function Activity({ projects, rows, width, now }: { projects: Project[]; rows: number; width: number; now: Date }): React.JSX.Element {
  const items = recentSessions(projects).slice(0, Math.max(1, rows));
  return (
    <Box flexDirection="column">
      {items.map(({ project, session }) => (
        <Line
          key={session.filePath}
          width={width}
          segs={[
            { t: agoLabel(session.lastActivity, now).padStart(8) + '  ', dim: true },
            { t: truncate(project.label, 14).padEnd(14) + ' ', dim: true },
            { t: glyphForStatus(session.status) + ' ', color: colorForStatus(session.status) },
            { t: session.title, flex: true },
          ]}
        />
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------

function turnSegs(turn: Turn): Seg[] {
  switch (turn.role) {
    case 'tool_use': {
      const i = turn.text.indexOf(': ');
      const name = i >= 0 ? turn.text.slice(0, i) : turn.text;
      const arg = i >= 0 ? turn.text.slice(i + 2) : '';
      return [{ t: truncate(name, 12).padEnd(12), bold: true }, { t: ' ' + arg, dim: true, flex: true }];
    }
    case 'tool_result':
      return [{ t: '  ' + (turn.isError ? '✗ ' : '✓ '), color: turn.isError ? 'red' : CHECK }, { t: turn.text, dim: true, flex: true }];
    case 'user':
      return [{ t: '› ', color: 'cyan' }, { t: turn.text, flex: true }];
    case 'assistant':
    default:
      return [{ t: '∴ ', color: ACCENT }, { t: turn.text, flex: true }];
  }
}

function LatestSession({ project, width, height, now }: { project: Project | undefined; width: number; height: number; now: Date }): React.JSX.Element {
  const session = project?.sessions[0];
  const textW = width - 4;
  const rows = Math.max(1, height - 2);
  const tail = session ? session.turns.slice(-rows) : [];
  return (
    <Panel
      width={width}
      height={height}
      title="Latest Session"
      subtitle={session ? `#${session.sessionId.slice(0, 8)}  ${session.title}` : '—'}
      meta={session ? `${glyphForStatus(session.status)} ${session.status} · ${agoLabel(session.lastActivity, now)} · ${session.turnCount} turns` : ''}
    >
      {tail.length === 0 ? (
        <Text dimColor>no transcript</Text>
      ) : (
        tail.map((turn, i) => <Line key={i} width={textW} segs={turnSegs(turn)} />)
      )}
    </Panel>
  );
}
