import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { ParsedSession, Project, Session } from './types.js';
import { parseSessionBody, resolveSnippet, resolveTitle } from './parse.js';
import { deriveStatus } from './status.js';
import { compareProjects, deriveSupervision, readProjectMemory } from './project.js';
import { deriveUserTasks } from './usertasks.js';
import type { GitStateCache } from './git.js';
import { isRunnerProjectDir, projectLabel, projectsRoot, resolveProjectPath } from '../utils/paths.js';

/**
 * Discovery and incremental reading of ~/.claude/projects.
 *
 * Two rules from docs/data-source.md drive the shape of this file:
 *  1. Only `.jsonl` DIRECTLY inside a project dir is a session. Files under
 *     `<session-id>/subagents/` are subagent transcripts and would otherwise
 *     inflate the count with phantom rows.
 *  2. A project dir with no `.jsonl` (e.g. one holding only `memory/`) is not a
 *     project and must not render as an empty group.
 */

/** Files larger than this are read from the tail only. */
export const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024; // 100 MB
/** How much of a very large file's tail to read. */
export const TAIL_BYTES = 2 * 1024 * 1024; // 2 MB

const SESSION_FILE_RE = /^([0-9a-fA-F-]{8,})\.jsonl$/;

export interface DiscoveredFile {
  filePath: string;
  projectDir: string;
  sessionId: string;
  size: number;
  mtime: Date;
}

/** Enumerate every session file under `claudeHome`, newest project first. */
export async function discoverSessionFiles(claudeHome: string): Promise<DiscoveredFile[]> {
  const root = projectsRoot(claudeHome);
  let projectDirs: string[];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return []; // no ~/.claude/projects at all
  }

  const out: DiscoveredFile[] = [];
  for (const dir of projectDirs) {
    // Sessions the --ai summariser creates are not the user's work, whatever
    // cache root they were made under.
    if (isRunnerProjectDir(dir)) continue;
    const dirPath = path.join(root, dir);
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // isFile() alone already excludes memory/ and <session-id>/ subdirs, so
      // subagents/*.jsonl is never reached: we do not recurse.
      if (!entry.isFile()) continue;
      const match = SESSION_FILE_RE.exec(entry.name);
      if (!match || !match[1]) continue;
      const filePath = path.join(dirPath, entry.name);
      try {
        const stat = await fs.stat(filePath);
        out.push({
          filePath,
          projectDir: dir,
          sessionId: match[1],
          size: stat.size,
          mtime: stat.mtime,
        });
      } catch {
        continue; // deleted between readdir and stat
      }
    }
  }
  return out;
}

/**
 * Read a transcript, tailing it when it is very large.
 *
 * Reading the tail can slice a line in half; parseLine drops the fragment, so a
 * tailed read loses at most one record at the seam.
 */
export async function readTranscript(filePath: string, size: number): Promise<string> {
  if (size <= LARGE_FILE_THRESHOLD) {
    return fs.readFile(filePath, 'utf8');
  }
  const start = Math.max(0, size - TAIL_BYTES);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { start });
    stream.on('data', (c) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  const text = Buffer.concat(chunks).toString('utf8');
  // Drop the (probably partial) first line.
  const nl = text.indexOf('\n');
  return nl >= 0 ? text.slice(nl + 1) : text;
}

/**
 * Per-file cache keyed by path.
 *
 * Re-parsing only happens when size or mtime moved. A file whose size SHRANK
 * below the cached size was truncated or rotated, so the cache is dropped and
 * the file re-read in full rather than resuming from a stale offset.
 */
interface CacheEntry {
  size: number;
  mtimeMs: number;
  parsed: ParsedSession;
}

export class SessionCache {
  private entries = new Map<string, CacheEntry>();

  async load(file: DiscoveredFile): Promise<ParsedSession> {
    const cached = this.entries.get(file.filePath);
    if (cached && cached.size === file.size && cached.mtimeMs === file.mtime.getTime()) {
      return cached.parsed;
    }
    const body = await readTranscript(file.filePath, file.size);
    const parsed = parseSessionBody(body, file.sessionId);
    this.entries.set(file.filePath, {
      size: file.size,
      mtimeMs: file.mtime.getTime(),
      parsed,
    });
    return parsed;
  }

  invalidate(filePath: string): void {
    this.entries.delete(filePath);
  }

  prune(livePaths: Set<string>): void {
    for (const key of this.entries.keys()) {
      if (!livePaths.has(key)) this.entries.delete(key);
    }
  }
}

/** Turn a parsed transcript plus its file stats into a display-ready Session. */
export function toSession(file: DiscoveredFile, parsed: ParsedSession, now = new Date()): Session {
  // Metadata records carry no timestamp and are often the last line, so the
  // last timestamped record can lag the file. Trust whichever is later.
  const lastActivity =
    parsed.lastTimestamp && parsed.lastTimestamp.getTime() > file.mtime.getTime()
      ? parsed.lastTimestamp
      : file.mtime;

  return {
    ...parsed,
    filePath: file.filePath,
    projectDir: file.projectDir,
    mtime: file.mtime,
    lastActivity,
    status: deriveStatus(parsed, lastActivity, now),
    title: resolveTitle(parsed),
    snippet: resolveSnippet(parsed),
  };
}

/** Group sessions by their project directory, newest project first. */
export function groupByProject(sessions: Session[], now = new Date()): Project[] {
  const byDir = new Map<string, Session[]>();
  for (const s of sessions) {
    const list = byDir.get(s.projectDir);
    if (list) list.push(s);
    else byDir.set(s.projectDir, [s]);
  }

  const projects: Project[] = [];
  for (const [dir, group] of byDir) {
    // The true path comes from a session's cwd -- the directory name is lossy
    // and cannot be decoded reliably. Prefer the most recently active session's.
    const sorted = group.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
    const candidates = new Set<string>();
    for (const s of sorted) for (const c of s.cwds) candidates.add(c);
    const projectPath = resolveProjectPath(dir, candidates);
    const first = sorted[0];
    projects.push({
      dir,
      path: projectPath,
      label: projectLabel(projectPath),
      sessions: sorted,
      lastActivity: first ? first.lastActivity : new Date(0),
      // Sessions-only supervision here; loadProjects re-derives with git and
      // memory, which need I/O this pure function must not do.
      supervision: deriveSupervision(sorted, now),
    });
  }

  return projects.sort(compareProjects);
}

export interface LoadExtras {
  /** When given, each project's git state is read (cached, read-only). */
  git?: GitStateCache;
  /** Read .env.example vs .env, and CI secrets, to find what only a human can do. */
  userTasks?: boolean;
  /** Ask GitHub which repository secrets exist. Needs the network. */
  checkSecrets?: boolean;
}

/** Full scan: discover, parse (via cache), derive, group, supervise. */
export async function loadProjects(
  claudeHome: string,
  cache: SessionCache,
  now = new Date(),
  extras: LoadExtras = {},
): Promise<Project[]> {
  const files = await discoverSessionFiles(claudeHome);
  cache.prune(new Set(files.map((f) => f.filePath)));

  const sessions: Session[] = [];
  for (const file of files) {
    try {
      const parsed = await cache.load(file);
      sessions.push(toSession(file, parsed, now));
    } catch {
      continue; // unreadable file (permissions, deleted mid-scan)
    }
  }
  const projects = groupByProject(sessions, now);

  // Enrich with what needs I/O. Git and memory reads run per project in
  // parallel; both are cheap and both degrade to "absent" rather than throw.
  await Promise.all(
    projects.map(async (project) => {
      const [git, memory, userTasks] = await Promise.all([
        extras.git ? extras.git.get(project.path) : Promise.resolve(undefined),
        readProjectMemory(claudeHome, project.dir),
        extras.userTasks
          ? deriveUserTasks(project.path, { checkSecrets: extras.checkSecrets })
          : Promise.resolve([]),
      ]);
      project.supervision = deriveSupervision(project.sessions, now, git, memory, userTasks);
    }),
  );
  extras.git?.prune(new Set(projects.map((p) => p.path)));
  return projects.sort(compareProjects);
}
