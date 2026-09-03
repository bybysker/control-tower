import type { GitState, NextStep, Plan, Session } from './types.js';
import { taskLabel } from './plan.js';

/**
 * What to do next in a project.
 *
 * Two sources, deliberately ordered by how much they know:
 *
 *   plan  what Claude itself said it would do (TaskCreate/TaskUpdate). The
 *         best signal when it exists -- on the machine this was built against
 *         it existed in 2 sessions out of 18, which is why it is not enough.
 *   git   what the repository state implies. Always available, deterministic,
 *         and mechanical: unpushed commits, an uncommitted tree, a branch with
 *         no upstream. It does not know what the work MEANS, only what is
 *         left hanging.
 *
 * A third source, `ai`, is opt-in and lives in summarize.ts.
 *
 * Nothing here guesses from prose: transcripts phrase next steps in French and
 * English, under half a dozen headings, in 4 sessions out of 18 -- too little
 * signal and too much noise to put in front of someone as a to-do list.
 */

/** Branches that are the trunk, and so imply no "merge back" step. */
const TRUNK = new Set(['main', 'master', 'trunk', 'develop', 'HEAD']);

export function planSteps(plan: Plan): NextStep[] {
  const pick = (status: 'in_progress' | 'pending'): NextStep[] =>
    plan.tasks
      .filter((t) => t.status === status)
      .map((t) => ({ source: 'plan' as const, id: `plan-${t.id}`, label: taskLabel(t), status: t.status }));
  return [...pick('in_progress'), ...pick('pending')];
}

/**
 * Steps implied by the working tree. Ordered by how close each is to losing
 * work: uncommitted first, then unpushed, then merge-back, then incoming.
 */
export function gitSteps(git: GitState | undefined): NextStep[] {
  if (!git || git.notARepo) return [];
  const out: NextStep[] = [];
  const step = (id: string, label: string): void => {
    out.push({ source: 'git', id: `git-${id}`, label });
  };

  if (git.changed > 0) {
    step('commit', `Commit or stash ${git.changed} changed file${git.changed === 1 ? '' : 's'}`);
  }
  if (git.ahead && git.ahead > 0) {
    step('push', `Push ${git.ahead} commit${git.ahead === 1 ? '' : 's'} to origin/${git.branch ?? 'HEAD'}`);
  }
  // No upstream at all: the branch exists only here.
  if (git.ahead === undefined && git.branch && !TRUNK.has(git.branch)) {
    step('publish', `Publish branch ${git.branch} — it has no upstream`);
  } else if (git.branch && !TRUNK.has(git.branch) && !git.dirty && !git.ahead) {
    // Clean and pushed, but still off trunk: the work is waiting to land.
    step('land', `Land ${git.branch} — clean and pushed, still off trunk`);
  }
  if (git.behind && git.behind > 0) {
    step('pull', `Pull ${git.behind} commit${git.behind === 1 ? '' : 's'} from origin/${git.branch ?? 'HEAD'}`);
  }
  // Untracked files are usually noise (build output, scratch), so they are
  // mentioned only when nothing else is outstanding.
  if (out.length === 0 && git.untracked > 0) {
    step('untracked', `${git.untracked} untracked file${git.untracked === 1 ? '' : 's'} — add or ignore`);
  }
  return out;
}

/** Plan first (it knows the intent), then the repository state. */
export function deriveNextSteps(sessions: Session[], git: GitState | undefined): NextStep[] {
  const byRecency = [...sessions].sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
  // The newest session that planned anything: an older plan is different work.
  const planned = byRecency.find((s) => s.plan.tasks.length > 0);
  return [...(planned ? planSteps(planned.plan) : []), ...gitSteps(git)];
}
