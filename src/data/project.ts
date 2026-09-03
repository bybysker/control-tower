import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  GitState,
  PrLink,
  Project,
  ProjectStatus,
  ProjectSupervision,
  Session,
  UserAction,
  UserTask,
} from './types.js';
import { deriveActions } from './actions.js';
import { deriveNextSteps } from './nextsteps.js';
import { STATUS_RANK } from './status.js';
import { projectsRoot } from '../utils/paths.js';

/**
 * Project-level supervision, derived from a project's sessions.
 *
 * A project is the thing the user supervises; sessions are its evidence. This
 * module folds the evidence into four answers -- what state is it in, what do I
 * have to do, where did we get to, what comes next -- without inventing any of
 * them: every field points back at a session it was read from.
 */

export const PROJECT_STATUS_RANK: Record<ProjectStatus, number> = {
  action: 0,
  failed: 1,
  running: 2,
  idle: 3,
  done: 4,
  stalled: 5,
};

const ACTION_RANK: Record<UserAction['kind'], number> = {
  answer: 0,
  failed: 1,
  permission: 2,
  reply: 3,
};

/** How old an action can be and still count as "for today". */
export const ACTION_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function deriveSupervision(
  sessions: Session[],
  now: Date = new Date(),
  git?: GitState,
  memory: string[] = [],
  userTasks: UserTask[] = [],
): ProjectSupervision {
  const byRecency = [...sessions].sort(
    (a, b) => b.lastActivity.getTime() - a.lastActivity.getTime(),
  );

  // Actions: every session's, newest and most certain first. A week-old
  // unanswered question is still true, but it stopped being "for today".
  // A `reply` counts only from the project's newest session: if the user has
  // since worked in another session of the same project, Claude's closing
  // question there was answered by moving on -- it is not still pending.
  const latestId = byRecency[0]?.sessionId;
  const actions = byRecency
    .flatMap((s) => deriveActions(s, now))
    .filter((a) => a.kind !== 'reply' || a.sessionId === latestId)
    .filter((a) => now.getTime() - a.since.getTime() < ACTION_STALE_AFTER_MS)
    .sort((a, b) => ACTION_RANK[a.kind] - ACTION_RANK[b.kind] || b.since.getTime() - a.since.getTime());

  const latest = byRecency[0];
  const whereWeAre =
    latest && latest.lastAssistantText
      ? { text: latest.lastAssistantText, sessionId: latest.sessionId, at: latest.lastActivity }
      : undefined;

  // Plan tasks when a session recorded any, then what the repository state
  // implies -- the latter is the only source that is always available.
  const nextSteps = deriveNextSteps(byRecency, git);

  const seen = new Set<string>();
  const prLinks: PrLink[] = [];
  for (const s of byRecency) {
    for (const pr of [...s.prLinks].reverse()) {
      if (seen.has(pr.url)) continue;
      seen.add(pr.url);
      prLinks.push(pr);
    }
  }

  // Status: the most attention-worthy session, with actions trumping all.
  let status: ProjectStatus = 'idle';
  if (actions.length > 0) status = 'action';
  else if (sessions.length > 0) {
    status = sessions
      .map((s) => s.status)
      .reduce((best, s) => (STATUS_RANK[s] < STATUS_RANK[best] ? s : best));
  }

  return { status, actions, whereWeAre, nextSteps, prLinks, git, memory, userTasks };
}

/**
 * Index lines of the project's auto-memory, `memory/MEMORY.md`, as plain text:
 * `- [Title](file.md) — hook` becomes `Title — hook`.
 */
export async function readProjectMemory(claudeHome: string, projectDir: string): Promise<string[]> {
  const file = path.join(projectsRoot(claudeHome), projectDir, 'memory', 'MEMORY.md');
  let body: string;
  try {
    body = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim())
    .filter(Boolean)
    .slice(0, 8);
}

/** Sort key for the root view: what needs attention first, then recency. */
export function compareProjects(a: Project, b: Project): number {
  return (
    PROJECT_STATUS_RANK[a.supervision.status] - PROJECT_STATUS_RANK[b.supervision.status] ||
    b.lastActivity.getTime() - a.lastActivity.getTime()
  );
}

/** `migration/postgres · dirty · ↑2 ↓1` -- only the parts that are true. */
export function describeGit(git: GitState | undefined): string {
  if (!git || git.notARepo) return '';
  const parts: string[] = [];
  if (git.branch) parts.push(git.branch);
  if (git.dirty) parts.push('dirty');
  if (git.ahead) parts.push(`↑${git.ahead}`);
  if (git.behind) parts.push(`↓${git.behind}`);
  return parts.join(' · ');
}
