import type { Plan, ParsedSession, Task } from './types.js';

/**
 * Current-plan helpers.
 *
 * Extraction itself happens during the single parse pass (see the
 * PlanAccumulator in parse.ts) so a transcript is never walked twice. This
 * module is the query layer over the result.
 *
 * IMPORTANT, and a deviation from the original spec: there is no `TodoWrite`
 * record anywhere in a Claude Code 2.1.x store -- zero occurrences of the tool
 * name and zero of the string "todos" across every session on the machine this
 * was built against. 2.1.x tracks the plan with TaskCreate/TaskUpdate instead.
 * Both extractors are implemented; TaskCreate/TaskUpdate wins when present.
 * See docs/data-source.md.
 */

export function getPlan(session: Pick<ParsedSession, 'plan'>): Plan {
  return session.plan;
}

export function hasPlan(session: Pick<ParsedSession, 'plan'>): boolean {
  return session.plan.tasks.length > 0;
}

/** The task currently being worked on, if any. */
export function currentTask(plan: Plan): Task | undefined {
  return plan.tasks.find((t) => t.status === 'in_progress');
}

export function planProgress(plan: Plan): { completed: number; total: number } {
  return {
    completed: plan.tasks.filter((t) => t.status === 'completed').length,
    total: plan.tasks.length,
  };
}

/**
 * Human label for a task row: the present-tense `activeForm` while it is being
 * worked on, the plain `subject` otherwise.
 */
export function taskLabel(task: Task): string {
  if (task.status === 'in_progress' && task.activeForm) return task.activeForm;
  return task.subject;
}
