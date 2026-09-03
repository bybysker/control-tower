import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../data/types.js';
import { SessionCache, loadProjects } from '../data/discover.js';
import { watchSessions, type WatcherHandle } from '../data/watch.js';
import { GitStateCache } from '../data/git.js';
import { SummaryStore, summarySteps } from '../data/summarize.js';

export interface UseSessionsOptions {
  claudeHome: string;
  /** Poll interval in ms. 0 disables polling (watcher only). */
  refreshInterval: number;
  /** Whether to run the chokidar watcher at all. */
  watch: boolean;
  /** Read each project's git state (the one thing read outside ~/.claude). */
  git: boolean;
  /** Allow asking Claude for next steps (the one thing that leaves the machine). */
  ai: boolean;
  /** Read .env key names to find what only the human can do. */
  userTasks: boolean;
  /** Ask GitHub which repository secrets exist. */
  checkSecrets: boolean;
}

export interface SessionsState {
  projects: Project[];
  loading: boolean;
  error?: string;
  /** Bumped on every successful scan -- lets the UI show a live heartbeat. */
  lastScan?: Date;
  refresh: () => void;
  /** Ask Claude for one project's next steps. No-op without --ai. */
  summarize: (projectDir: string) => void;
  /** Bumped whenever a summary starts, finishes, or fails. */
  summaryTick: number;
  summaries: SummaryStore;
}

/**
 * Loads projects once, then keeps them fresh from two independent sources:
 * a chokidar watcher (fast, event-driven) and a poll (slow, catches missed
 * events). Both funnel into the same scan, and the per-file cache makes a
 * no-op scan cheap.
 */
export function useSessions({
  claudeHome,
  refreshInterval,
  watch,
  git,
  ai,
  userTasks,
  checkSecrets,
}: UseSessionsOptions): SessionsState {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [lastScan, setLastScan] = useState<Date | undefined>();

  const cacheRef = useRef(new SessionCache());
  const gitRef = useRef(new GitStateCache());
  const summariesRef = useRef(new SummaryStore());
  const [summaryTick, setSummaryTick] = useState(0);
  const scanningRef = useRef(false);
  const mountedRef = useRef(true);

  const scan = useCallback(async () => {
    // A slow scan must not stack up behind the poll timer.
    if (scanningRef.current) return;
    scanningRef.current = true;
    try {
      const next = await loadProjects(claudeHome, cacheRef.current, new Date(), {
        git: git ? gitRef.current : undefined,
        userTasks,
        checkSecrets,
      });
      if (!mountedRef.current) return;
      setProjects(next);
      setError(undefined);
      setLastScan(new Date());
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      scanningRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, [claudeHome, git, userTasks, checkSecrets]);

  useEffect(() => {
    mountedRef.current = true;
    void scan();

    let watcher: WatcherHandle | undefined;
    if (watch) {
      watcher = watchSessions(claudeHome, () => {
        void scan();
      });
    }

    // Poll even when watching: fs events are missed on network mounts and
    // under some editors, and statuses age out on their own (a running
    // session becomes idle after 10s with no new events at all).
    const interval =
      refreshInterval > 0
        ? setInterval(() => {
            void scan();
          }, refreshInterval)
        : undefined;

    return () => {
      mountedRef.current = false;
      if (interval) clearInterval(interval);
      void watcher?.close();
    };
  }, [claudeHome, refreshInterval, watch, scan]);

  const refresh = useCallback(() => {
    void scan();
  }, [scan]);

  // Summaries are merged into each project's next steps as they land, so the
  // panel fills in without a rescan.
  const withSummaries = useMemo(() => {
    if (!ai) return projects;
    return projects.map((p) => {
      const steps = summarySteps(summariesRef.current.get(p.dir));
      return steps.length === 0
        ? p
        : { ...p, supervision: { ...p.supervision, nextSteps: [...p.supervision.nextSteps, ...steps] } };
    });
    // summaryTick is the signal that the store changed; the store itself is a ref.
  }, [projects, ai, summaryTick]);

  const summarize = useCallback(
    (projectDir: string) => {
      if (!ai) return;
      const project = projects.find((p) => p.dir === projectDir);
      if (!project) return;
      void summariesRef.current.request(
        project.dir,
        project.label,
        project.path,
        project.sessions,
        project.supervision.git,
        project.lastActivity,
        () => setSummaryTick((n) => n + 1),
      );
    },
    [ai, projects],
  );

  useEffect(() => {
    if (!ai) return;
    void summariesRef.current.load().then(() => setSummaryTick((n) => n + 1));
  }, [ai]);

  return {
    projects: withSummaries,
    loading,
    error,
    lastScan,
    refresh,
    summarize,
    summaryTick,
    summaries: summariesRef.current,
  };
}
