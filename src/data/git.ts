import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';

/**
 * Read-only git state for a project directory.
 *
 * This is the one thing Control Tower reads outside ~/.claude. It runs
 * `git status --porcelain=v2 --branch` -- a query, never a mutation -- and only
 * in directories that exist. Results are cached per path so a scan every two
 * seconds does not spawn a process per project every two seconds.
 */

import type { GitState } from './types.js';
export type { GitState };

/** Re-query a path at most this often. */
export const GIT_CACHE_TTL_MS = 10_000;
const GIT_TIMEOUT_MS = 3_000;

/**
 * Parse `git status --porcelain=v2 --branch` output. Pure, so it is testable
 * without spawning git.
 *
 *   # branch.oid <sha>
 *   # branch.head <name> | (detached)
 *   # branch.upstream <remote/branch>          (only when tracking)
 *   # branch.ab +<ahead> -<behind>              (only when tracking)
 *   1 <XY> ... / 2 <XY> ... / u <XY> ...        changed / renamed / unmerged
 *   ? <path>                                    untracked
 */
export function parsePorcelainV2(output: string): GitState {
  const state: GitState = { dirty: false, changed: 0, untracked: 0, notARepo: false };
  for (const line of output.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      state.branch = head === '(detached)' ? 'HEAD' : head;
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m && m[1] !== undefined && m[2] !== undefined) {
        state.ahead = Number(m[1]);
        state.behind = Number(m[2]);
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      state.dirty = true;
      state.changed++;
    } else if (line.startsWith('? ')) {
      state.untracked++;
    }
  }
  return state;
}

function runGitStatus(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['status', '--porcelain=v2', '--branch'],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

interface CacheEntry {
  at: number;
  state: GitState;
}

export class GitStateCache {
  private entries = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<GitState>>();

  /**
   * State for `cwd`, from cache when fresh. Never throws: a missing directory,
   * a non-repo, or a git failure all resolve to `notARepo: true`.
   */
  async get(cwd: string, now = Date.now()): Promise<GitState> {
    const cached = this.entries.get(cwd);
    if (cached && now - cached.at < GIT_CACHE_TTL_MS) return cached.state;

    const pending = this.inflight.get(cwd);
    if (pending) return pending;

    const task = (async (): Promise<GitState> => {
      let state: GitState;
      try {
        await fs.access(cwd);
        state = parsePorcelainV2(await runGitStatus(cwd));
      } catch {
        state = { dirty: false, changed: 0, untracked: 0, notARepo: true };
      }
      this.entries.set(cwd, { at: Date.now(), state });
      this.inflight.delete(cwd);
      return state;
    })();
    this.inflight.set(cwd, task);
    return task;
  }

  prune(livePaths: Set<string>): void {
    for (const key of this.entries.keys()) if (!livePaths.has(key)) this.entries.delete(key);
  }
}
