import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve the Claude Code home, honouring an explicit --path override. */
export function resolveClaudeHome(override?: string): string {
  if (override && override.trim().length > 0) {
    return path.resolve(expandTilde(override.trim()));
  }
  return path.join(os.homedir(), '.claude');
}

export function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function projectsRoot(claudeHome: string): string {
  return path.join(claudeHome, 'projects');
}

/**
 * Encode an absolute path the way Claude Code names its project directories:
 * both '/' and '.' become '-'.
 *
 *   /home/alice/code/bootcamp/rag-eval-v2.1
 *     -> -home-alice-code-bootcamp-rag-eval-v2-1
 */
export function encodeProjectDir(absPath: string): string {
  return absPath.replace(/\/+$/, '').replace(/[/.]/g, '-');
}

/**
 * Best-effort human path for an encoded project directory, used ONLY when no
 * candidate cwd matches.
 *
 * The encoding is lossy -- `-home-alice-code-bootcamp-rag-eval-v2-1` could
 * be `.../rag-eval-v2.1` or `.../rag-eval/v2/1` -- so this guess assumes every '-'
 * was a '/'. Prefer resolveProjectPath(). See docs/data-source.md.
 */
export function decodeProjectDir(dir: string): string {
  const withoutLeading = dir.replace(/^-/, '');
  return '/' + withoutLeading.replace(/-/g, '/');
}

/**
 * Recover a project's true absolute path from the cwd values observed in its
 * transcripts.
 *
 * A session's cwd changes as Claude moves around: one project directory here
 * held ten distinct cwd values, most of them subdirectories, so "last cwd wins"
 * names the project after whichever folder was visited last. Instead we treat
 * every observed cwd as a CANDIDATE and keep the one that re-encodes to exactly
 * the directory name. That check is exact even though decoding is not, and it
 * recovers dotted paths for free (rag-eval-v2.1 encodes back to rag-eval-v2-1).
 */
export function resolveProjectPath(dir: string, candidates: Iterable<string>): string {
  let shortestFallback: string | undefined;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (encodeProjectDir(candidate) === dir) return candidate;
    // Keep the shallowest cwd as a fallback: it is the likeliest ancestor.
    if (!shortestFallback || candidate.length < shortestFallback.length) {
      shortestFallback = candidate;
    }
  }
  return shortestFallback ?? decodeProjectDir(dir);
}

/**
 * Short label for the root view: the last path segment, or
 * "<segment> (root)" when the project IS the directory the user works from.
 */
export function projectLabel(absPath: string, homeDir = os.homedir()): string {
  const normalised = absPath.replace(/\/+$/, '');
  const base = path.basename(normalised);
  if (!base) return normalised || '/';
  // A project directly under $HOME reads better with its parent implied.
  const parent = path.dirname(normalised);
  if (parent === homeDir) return base;
  return base;
}

/** True when `p` sits directly inside a project dir (not under subagents/ etc). */
export function isDirectChild(projectDirPath: string, filePath: string): boolean {
  return path.dirname(filePath) === projectDirPath;
}

/** Where Control Tower keeps its own state. Never inside ~/.claude. */
export function cacheDir(): string {
  const base = process.env['XDG_CACHE_HOME'] || path.join(os.homedir(), '.cache');
  return path.join(base, 'control-tower');
}

/**
 * The cwd `claude -p` runs in when summarising.
 *
 * `claude -p` always writes a session, and a session's project directory comes
 * from its cwd -- so running the summariser inside a project makes the tool
 * pollute the very store it reads, and its own one-shot session becomes that
 * project's newest, hijacking "where we are". Running from here puts every
 * summariser session in one directory, which discovery then skips.
 */
export function summaryRunnerDir(): string {
  return path.join(cacheDir(), 'runner');
}

/** The encoded project-directory name discovery must ignore. */
export function summaryRunnerProjectDir(): string {
  return encodeProjectDir(summaryRunnerDir());
}

/**
 * The tail every runner directory encodes to, whatever the cache root.
 *
 * Matching the full encoded path would only skip runs made under the CURRENT
 * $XDG_CACHE_HOME; a run made under another root (a test harness, another
 * machine's store copied here) would be scanned as if it were a project. The
 * suffix is what actually identifies it.
 */
export const RUNNER_DIR_SUFFIX = '-control-tower-runner';

export function isRunnerProjectDir(dir: string): boolean {
  return dir.endsWith(RUNNER_DIR_SUFFIX);
}

/**
 * The plugin shipped with Control Tower: skills and agents that operate the
 * supervision workflow.
 *
 * Resolved from this module's own location rather than the cwd, because the
 * --ai runner deliberately executes outside every project. The bundle lands at
 * <package>/dist/cli.js, so the plugin is its sibling one level up; in dev the
 * module is under <repo>/src/utils, so the same walk needs one more level.
 */
export function pluginDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/cli.js -> <package>/plugin ; src/utils/paths.ts -> <repo>/plugin
  const candidate = path.basename(here) === 'dist' ? path.join(here, '..') : path.join(here, '..', '..');
  return path.join(candidate, 'plugin');
}
