import React, { useEffect, useMemo, useState } from 'react';
import { Box, useApp, useStdout } from 'ink';
import { Spinner } from '@inkjs/ui';
import type { Project, Session } from './data/types.js';
import { useSessions } from './hooks/useSessions.js';
import { useKeymap } from './hooks/useKeymap.js';
import { Dashboard } from './components/Dashboard.js';
import { FooterBar, HeaderBar, type KeyHint, Panel, Rule } from './components/Frame.js';
import { ProjectView, projectRows } from './components/ProjectView.js';
import { SessionDetail, transcriptCapacity } from './components/SessionDetail.js';
import { agoLabel, glyphForProject, glyphForStatus } from './utils/format.js';
import { planProgress } from './data/plan.js';

export interface AppProps {
  claudeHome: string;
  refreshInterval: number;
  watch: boolean;
  git: boolean;
  ai: boolean;
  userTasks: boolean;
  checkSecrets: boolean;
  initialFilter: string;
  /** Paint one frame, then exit. `--once` on a terminal. */
  once?: boolean;
}

/**
 * Three levels: projects (root) -> one project -> one transcript. Each level is
 * addressed by a stable key (project dir, session file path), never an index,
 * so a live re-sort underneath never swaps what the user is looking at.
 */
type View = 'root' | 'project' | 'detail';

export function filterProjects(projects: Project[], query: string): Project[] {
  const q = query.trim().toLowerCase();
  if (!q) return projects;
  const out: Project[] = [];
  for (const p of projects) {
    // A match on the project itself, its status, or one of its actions keeps
    // the whole project; otherwise the filter descends to sessions.
    const projectMatches =
      p.label.toLowerCase().includes(q) ||
      p.path.toLowerCase().includes(q) ||
      p.dir.toLowerCase().includes(q) ||
      p.supervision.status.includes(q) ||
      p.supervision.actions.some((a) => a.kind.includes(q) || a.label.toLowerCase().includes(q));
    const sessions = projectMatches
      ? p.sessions
      : p.sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            s.status.toLowerCase().includes(q) ||
            s.snippet.toLowerCase().includes(q),
        );
    if (sessions.length > 0) out.push({ ...p, sessions });
  }
  return out;
}

export function App({
  claudeHome,
  refreshInterval,
  watch,
  git,
  ai,
  userTasks,
  checkSecrets,
  initialFilter,
  once = false,
}: AppProps): React.JSX.Element {
  const { stdout } = useStdout();
  const { exit } = useApp();
  const width = Math.max(60, stdout?.columns ?? 100);
  const height = Math.max(12, stdout?.rows ?? 30);

  const { projects, loading, error, refresh, summarize, summaries, summaryTick } = useSessions({
    claudeHome,
    refreshInterval,
    watch,
    git,
    ai,
    userTasks,
    checkSecrets,
  });

  const [filter, setFilter] = useState(initialFilter);
  const [filterDraft, setFilterDraft] = useState(initialFilter);
  const [filtering, setFiltering] = useState(false);
  const [cursor, setCursor] = useState(0); // root: project index
  const [rowCursor, setRowCursor] = useState(0); // project view: actions, then sessions
  const [openDir, setOpenDir] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [scroll, setScroll] = useState(0);
  // Set when the transcript was opened from a NEEDS YOU action: the turn that
  // action is about, quoted at the top of the detail view.
  const [focusTurn, setFocusTurn] = useState<number | undefined>(undefined);
  // Re-render on a timer so "2s ago" keeps counting even with no fs events.
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // --once on a terminal: Ink leaves the last frame on screen when it
  // unmounts, so exiting right after the first real paint is the snapshot.
  useEffect(() => {
    if (!once || loading) return;
    const t = setTimeout(() => exit(), 80);
    return () => clearTimeout(t);
  }, [once, loading, exit]);

  const visibleProjects = useMemo(
    () => filterProjects(projects, filtering ? filterDraft : filter),
    [projects, filter, filterDraft, filtering],
  );

  // Keep cursors in range as projects and sessions come and go underneath.
  const projectIndex = visibleProjects.length === 0 ? 0 : Math.min(cursor, visibleProjects.length - 1);
  const currentProject = visibleProjects[projectIndex];

  const openProject = useMemo(
    () => (openDir ? projects.find((p) => p.dir === openDir) ?? null : null),
    [projects, openDir],
  );
  const openSession = useMemo<Session | null>(() => {
    if (!openFile) return null;
    for (const p of projects) {
      const found = p.sessions.find((s) => s.filePath === openFile);
      if (found) return found;
    }
    return null;
  }, [projects, openFile]);

  const view: View = openSession ? 'detail' : openProject ? 'project' : 'root';
  const projectRowCount = openProject ? projectRows(openProject) : 0;
  const rowIndex = openProject ? Math.min(rowCursor, Math.max(0, projectRowCount - 1)) : 0;
  const actionCount = openProject?.supervision.actions.length ?? 0;
  // Frame chrome: top rule, 2 header rows, rule, panel, rule, footer, bottom
  // rule = 8 rows around the panel, and the whole frame stays at rows - 1.
  const panelH = Math.max(6, height - 8);
  const innerW = width - 4;
  const innerH = panelH - 2; // panel heading + blank
  const maxScroll = openSession
    ? Math.max(0, openSession.turns.length - transcriptCapacity(openSession, innerH, innerW, focusTurn))
    : 0;

  useKeymap(
    { filtering, view: view === 'detail' ? 'detail' : 'root' },
    {
      onUp: () => {
        if (view === 'detail') setScroll((s) => Math.max(0, s - 1));
        else if (view === 'project') setRowCursor((c) => Math.max(0, Math.min(c, rowIndex) - 1));
        else setCursor((c) => Math.max(0, Math.min(c, projectIndex) - 1));
      },
      onDown: () => {
        if (view === 'detail') setScroll((s) => Math.min(maxScroll, s + 1));
        else if (view === 'project') setRowCursor((c) => Math.min(projectRowCount - 1, c + 1));
        else setCursor((c) => Math.min(visibleProjects.length - 1, c + 1));
      },
      onEnter: () => {
        if (view === 'detail') return;
        if (view === 'project' && openProject) {
          // An action row: go to the session it names, at the turn it is about.
          // Nothing is resumed or answered -- we only stop making you look.
          const action = openProject.supervision.actions[rowIndex];
          if (rowIndex < actionCount && action) {
            const target = openProject.sessions.find((s) => s.sessionId === action.sessionId);
            if (!target) return;
            const at = action.turnIndex;
            setOpenFile(target.filePath);
            setFocusTurn(at);
            const capacity = transcriptCapacity(target, innerH, innerW, at);
            setScroll(
              at === undefined
                ? Math.max(0, target.turns.length - capacity)
                : // Two rows of run-up, so the turn arrives with its context.
                  Math.min(Math.max(0, target.turns.length - capacity), Math.max(0, at - 2)),
            );
            return;
          }
          const session = openProject.sessions[rowIndex - actionCount];
          if (!session) return;
          setOpenFile(session.filePath);
          setFocusTurn(undefined);
          // Open at the bottom: the newest turns are the point of the view.
          setScroll(Math.max(0, session.turns.length - transcriptCapacity(session, innerH, innerW)));
          return;
        }
        if (currentProject) {
          setOpenDir(currentProject.dir);
          setRowCursor(0);
        }
      },
      onBack: () => {
        if (view === 'detail') {
          setOpenFile(null);
          setFocusTurn(undefined);
          setScroll(0);
        } else if (view === 'project') {
          setOpenDir(null);
        }
      },
      onToggleFold: () => {
        /* no folding on cards; kept for the keymap's sake */
      },
      onRefresh: refresh,
      onSummarize: () => {
        const target = view === 'project' ? openProject : currentProject;
        if (target) summarize(target.dir);
      },
      onStartFilter: () => {
        if (view !== 'root') return;
        setFilterDraft(filter);
        setFiltering(true);
      },
      onFilterChar: (char) => setFilterDraft((d) => d + char),
      onFilterBackspace: () => setFilterDraft((d) => d.slice(0, -1)),
      onFilterCommit: () => {
        setFilter(filterDraft);
        setFiltering(false);
        setCursor(0);
      },
      onFilterCancel: () => {
        setFilterDraft(filter);
        setFiltering(false);
      },
    },
  );

  const note = !watch && refreshInterval === 0 ? 'manual refresh only' : !watch ? 'poll-only' : undefined;
  const sessionsTotal = projects.reduce((n, p) => n + p.sessions.length, 0);
  const needs = projects.reduce((n, p) => n + p.supervision.actions.length, 0);
  const runningCount = projects.reduce((n, p) => n + p.sessions.filter((s) => s.status === 'running').length, 0);
  const metrics = [
    { label: 'Projects', value: String(projects.length) },
    { label: 'Sessions', value: String(sessionsTotal) },
    { label: 'Needs you', value: String(needs) },
    { label: 'Running', value: String(runningCount) },
  ];

  if (loading) {
    return (
      <Box padding={1}>
        <Spinner label={`Scanning ${claudeHome} …`} />
      </Box>
    );
  }

  /** A deep view: the same frame, one full-width panel. */
  const framed = (
    status: string,
    statusColor: string,
    progress: { ratio: number; label: string },
    panel: { title: string; subtitle?: string; meta?: string },
    keys: KeyHint[],
    body: React.ReactNode,
  ): React.JSX.Element => (
    <Box flexDirection="column" width={width}>
      <Rule width={width} edge="top" />
      <HeaderBar
        width={width}
        path={claudeHome}
        metrics={metrics}
        status={status}
        statusColor={statusColor}
        progress={progress.ratio}
        progressLabel={progress.label}
      />
      <Rule width={width} edge="middle" />
      <Panel width={width} height={panelH} title={panel.title} subtitle={panel.subtitle} meta={panel.meta}>
        {body}
      </Panel>
      <Rule width={width} edge="middle" />
      <FooterBar width={width} keys={keys} note={note} error={error} />
      <Rule width={width} edge="bottom" />
    </Box>
  );

  if (openSession) {
    const prog = planProgress(openSession.plan);
    return framed(
      openSession.status.toUpperCase(),
      openSession.status === 'running' ? '#E8722A' : openSession.status === 'failed' ? '#FF7B7B' : 'gray',
      // No plan: the bar is the reading position in the transcript.
      prog.total
        ? { ratio: prog.completed / prog.total, label: `${prog.completed}/${prog.total}` }
        : { ratio: maxScroll ? Math.min(scroll, maxScroll) / maxScroll : 1, label: `${openSession.turns.length} turns` },
      { title: 'Session', subtitle: `#${openSession.sessionId.slice(0, 8)}  ${openSession.title}`, meta: `${glyphForStatus(openSession.status)} ${openSession.status} · ${agoLabel(openSession.lastActivity, now)}` },
      [
        { key: '↑↓', label: 'Scroll' },
        { key: 'Esc', label: 'Back' },
        { key: 'R', label: 'Refresh' },
        { key: 'Q', label: 'Quit' },
      ],
      <SessionDetail session={openSession} scroll={Math.min(scroll, maxScroll)} width={innerW} height={innerH} now={now} focus={focusTurn} />,
    );
  }

  if (openProject) {
    const s = openProject.supervision;
    const planned = openProject.sessions.find((x) => x.plan.tasks.length > 0);
    const prog = planned ? planProgress(planned.plan) : { completed: 0, total: 0 };
    return framed(
      s.status === 'action' ? 'NEEDS YOU' : s.status.toUpperCase(),
      s.status === 'action' ? '#FF7B7B' : s.status === 'running' ? '#E8722A' : 'gray',
      { ratio: prog.total ? prog.completed / prog.total : 0, label: prog.total ? `${prog.completed}/${prog.total}` : `${openProject.sessions.length} sessions` },
      { title: 'Project', subtitle: openProject.label, meta: `${glyphForProject(s.status)} ${s.status} · ${agoLabel(openProject.lastActivity, now)}` },
      [
        { key: '↑↓', label: actionCount > 0 ? 'Needs you · sessions' : 'Sessions' },
        { key: '⏎', label: 'Transcript' },
        ...(ai ? [{ key: 'A', label: 'Next steps' }] : []),
        { key: 'Esc', label: 'Back' },
        { key: 'R', label: 'Refresh' },
        { key: 'Q', label: 'Quit' },
      ],
      <ProjectView project={openProject} cursor={rowIndex} width={innerW} height={innerH} now={now} />,
    );
  }

  const shownSessions = visibleProjects.reduce((n, p) => n + p.sessions.length, 0);
  const isFiltered = (filtering ? filterDraft : filter).trim().length > 0;

  return (
    <Dashboard
      claudeHome={claudeHome}
      projects={visibleProjects}
      allProjects={projects}
      selected={projectIndex}
      width={width}
      height={height}
      now={now}
      filter={isFiltered || filtering ? { value: filtering ? filterDraft : filter, active: filtering, matches: shownSessions } : undefined}
      note={note}
      error={error}
      ai={ai}
      summary={currentProject ? summaries.get(currentProject.dir) : undefined}
      summaryTick={summaryTick}
    />
  );
}
