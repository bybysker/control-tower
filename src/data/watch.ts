import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';
import { projectsRoot } from '../utils/paths.js';

/**
 * Filesystem watching for ~/.claude/projects.
 *
 * Transcripts are appended to constantly while a session runs, so raw events
 * arrive in bursts. Everything is debounced into a single "something changed"
 * callback; the caller re-scans and lets the per-file cache in discover.ts skip
 * whatever did not actually move.
 */

export const DEFAULT_DEBOUNCE_MS = 500;

export interface WatcherHandle {
  close: () => Promise<void>;
}

export interface WatchOptions {
  debounceMs?: number;
  onError?: (error: Error) => void;
}

/**
 * Watch every session transcript, calling `onChange` at most once per
 * debounce window.
 *
 * Depth is capped at 1 (project dir -> file) so subagent transcripts nested
 * under <session-id>/subagents/ never trigger a reload -- they are not
 * sessions, and a busy subagent would otherwise churn the whole UI.
 */
export function watchSessions(
  claudeHome: string,
  onChange: () => void,
  options: WatchOptions = {},
): WatcherHandle {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const root = projectsRoot(claudeHome);

  let timer: NodeJS.Timeout | undefined;
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      onChange();
    }, debounceMs);
  };

  const watcher: FSWatcher = chokidar.watch(root, {
    depth: 1,
    ignoreInitial: true,
    persistent: true,
    // A transcript is written continuously; we want the events, not the
    // settled file, so no awaitWriteFinish -- the debounce does that job.
    ignored: (p: string) => {
      const base = path.basename(p);
      return base === 'subagents' || base === 'tool-results' || base === 'memory';
    },
  });

  watcher.on('add', schedule);
  watcher.on('change', schedule);
  watcher.on('unlink', schedule);
  if (options.onError) {
    watcher.on('error', (e) => options.onError?.(e instanceof Error ? e : new Error(String(e))));
  } else {
    watcher.on('error', () => {
      /* a watcher failure must never crash the TUI; polling still covers us */
    });
  }

  return {
    close: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}
