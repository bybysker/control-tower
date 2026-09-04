import { describe, expect, it } from 'vitest';
import type { Project, Session, Turn, UserAction } from '../src/data/types.js';
import { deriveActions } from '../src/data/actions.js';
import { actionLocator, columns } from '../src/utils/format.js';
import { focusBlockRows, transcriptCapacity } from '../src/components/SessionDetail.js';
import { projectRows, projectViewFixedRows } from '../src/components/ProjectView.js';

/**
 * A NEEDS YOU card used to name a symptom and stop: which terminal holds the
 * session, and what the error text actually said, were both left to be hunted
 * for. These cover the two things that replaced the hunt -- the locator line,
 * and the turn index the transcript opens at -- and the row budgets they cost,
 * because a view that overruns its height makes Ink clear the screen.
 */

const NOW = new Date('2026-09-02T10:00:00Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

function makeSession(over: Partial<Session> = {}): Session {
  return {
    sessionId: 'aaaaaaaa-0000-0000-0000-000000000000',
    cwds: ['/home/dev/bootcamp/api'],
    cwd: '/home/dev/bootcamp/api',
    entrypoint: 'cli',
    firstTimestamp: ago(4 * 3_600_000),
    turnCount: 2,
    turns: [],
    plan: { source: 'none', tasks: [] },
    lastStopReason: 'end_turn',
    endsMidWork: false,
    lastToolErrored: false,
    lastToolRejectedByUser: false,
    prLinks: [],
    malformedLines: 0,
    filePath: '/x/a.jsonl',
    projectDir: '-p',
    mtime: ago(60_000),
    lastActivity: ago(60_000),
    status: 'done',
    title: 'Wire up the parser',
    snippet: '',
    ...over,
  };
}

const use = (toolName: string, text: string): Turn => ({ role: 'tool_use', toolName, text });
const result = (text: string, isError = false): Turn => ({ role: 'tool_result', text, isError });

describe('an action says which session, not that anything is still alive', () => {
  it('carries the entrypoint, start time and cwd off the session', () => {
    const [a] = deriveActions(makeSession({ lastAssistantText: 'Shall I push?' }), NOW);
    expect(a?.entrypoint).toBe('cli');
    expect(a?.cwd).toBe('/home/dev/bootcamp/api');
    expect(a?.startedAt).toEqual(ago(4 * 3_600_000));
  });

  it('renders them as one line: title, entrypoint, start, path tail, short id', () => {
    const [a] = deriveActions(makeSession({ lastAssistantText: 'Shall I push?' }), NOW);
    expect(actionLocator(a as UserAction, NOW)).toBe(
      'Wire up the parser · cli · started 4h ago · /home/dev/bootcamp/api · #aaaaaaaa',
    );
  });

  it('keeps the tail of a long path, and never grows without bound', () => {
    const deep = '/Users/someone/Development/clients/acme/services/payments-api';
    const [a] = deriveActions(makeSession({ cwd: deep, lastAssistantText: 'Ready?' }), NOW);
    const line = actionLocator(a as UserAction, NOW);
    expect(line).toContain('/services/payments-api');
    expect(line).not.toContain('/Users/someone');
    expect(columns(line)).toBeLessThanOrEqual(32 + 34 + 40);
  });

  it('omits what the transcript never recorded rather than guessing', () => {
    const [a] = deriveActions(
      makeSession({ entrypoint: undefined, cwd: undefined, firstTimestamp: undefined, lastAssistantText: 'Ready?' }),
      NOW,
    );
    expect(actionLocator(a as UserAction, NOW)).toBe('Wire up the parser · #aaaaaaaa');
  });
});

describe('an action points at the turn it is about', () => {
  it('a "fix" points at the failing result, not the last turn', () => {
    const turns = [use('Bash', 'Bash: npm test'), result('FAIL tests/auth.spec.ts', true), { role: 'assistant', text: 'Looking at it.' } as Turn];
    const [a] = deriveActions(makeSession({ status: 'failed', lastToolErrored: true, turns }), NOW);
    expect(a?.kind).toBe('failed');
    expect(a?.turnIndex).toBe(1);
  });

  it('an "unblock" points at the call still waiting', () => {
    const turns = [use('Read', 'Read: src/app.tsx'), result('ok'), use('Bash', 'Bash: rm -rf build')];
    const [a] = deriveActions(
      makeSession({ pendingToolName: 'Bash', endsMidWork: true, status: 'idle', lastActivity: ago(30_000), turns }),
      NOW,
    );
    expect(a?.kind).toBe('permission');
    expect(a?.turnIndex).toBe(2);
  });

  it('an "answer" points at the AskUserQuestion', () => {
    const turns = [{ role: 'assistant', text: 'Two ways to go.' } as Turn, use('AskUserQuestion', 'AskUserQuestion: Push?')];
    const [a] = deriveActions(
      makeSession({
        pendingQuestion: { question: 'Push?', options: ['Yes', 'No'] },
        pendingToolName: 'AskUserQuestion',
        endsMidWork: true,
        turns,
      }),
      NOW,
    );
    expect(a?.turnIndex).toBe(1);
  });

  it('leaves the index undefined when the tail no longer holds the turn', () => {
    // `turns` is bounded, so an old session legitimately has nothing to point
    // at. That is not an error and must not become index 0.
    const [a] = deriveActions(makeSession({ status: 'failed', lastToolErrored: true, turns: [] }), NOW);
    expect(a?.kind).toBe('failed');
    expect(a?.turnIndex).toBeUndefined();
  });
});

describe('the rows the pointing costs are paid for', () => {
  const failing = makeSession({
    status: 'failed',
    lastToolErrored: true,
    turns: [use('Bash', 'Bash: npm test'), result('FAIL tests/auth.spec.ts', true)],
  });

  const W = 114;

  it('transcriptCapacity subtracts exactly what the focus block occupies', () => {
    const H = 40;
    // blank + heading + call + one wrapped line: a short error costs 4 rows.
    expect(focusBlockRows(failing, H, W, 1)).toBe(4);
    expect(transcriptCapacity(failing, H, W) - transcriptCapacity(failing, H, W, 1)).toBe(4);
  });

  it('grows with the text it has to show, up to its cap', () => {
    const long = makeSession({
      status: 'failed',
      lastToolErrored: true,
      turns: [use('Bash', 'Bash: npm test'), result('word '.repeat(400), true)],
    });
    // 3 chrome rows + FOCUS_TEXT_LINES; more text than that is ellipsed, never
    // paid for twice.
    expect(focusBlockRows(long, 40, W, 1)).toBe(7);
    expect(focusBlockRows(long, 40, 40, 1)).toBe(7);
  });

  it('costs nothing when there is no focus, or the turn is not in the tail', () => {
    expect(focusBlockRows(failing, 40, W, undefined)).toBe(0);
    expect(focusBlockRows(failing, 40, W, 99)).toBe(0);
    expect(transcriptCapacity(failing, 40, W, 99)).toBe(transcriptCapacity(failing, 40, W));
  });

  it('is dropped rather than squeezing the transcript on a short terminal', () => {
    // The block is worth its rows only if what is left still reads as a
    // transcript; below that the anchored scroll alone has to do.
    expect(focusBlockRows(failing, 15, W, 1)).toBe(0);
    expect(transcriptCapacity(failing, 15, W, 1)).toBe(transcriptCapacity(failing, 15, W));
  });

  it('the project view budgets one locator row per action', () => {
    const withAction = project([failing]);
    const quiet = project([makeSession({ status: 'done' })]);
    expect(withAction.supervision.actions).toHaveLength(1);
    // needs-you rule + the action + its locator = 3 rows over the quiet view.
    expect(projectViewFixedRows(withAction, 100) - projectViewFixedRows(quiet, 100)).toBe(3);
  });

  it('the ↑↓ list is the actions and then the sessions', () => {
    const p = project([failing]);
    expect(projectRows(p)).toBe(p.supervision.actions.length + p.sessions.length);
    expect(projectRows(p)).toBe(2);
  });
});

/** A project carrying exactly these sessions, supervision derived from them. */
function project(sessions: Session[]): Project {
  return {
    dir: '-home-dev-bootcamp-api',
    path: '/home/dev/bootcamp/api',
    label: 'api',
    sessions,
    lastActivity: sessions[0]?.lastActivity ?? NOW,
    supervision: {
      status: 'action',
      actions: sessions.flatMap((s) => deriveActions(s, NOW)),
      nextSteps: [],
      userTasks: [],
      prLinks: [],
      memory: [],
    },
  };
}
