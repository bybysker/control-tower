import { describe, expect, it } from 'vitest';
import { parseSessionBody } from '../src/data/parse.js';
import { currentTask, planProgress, taskLabel } from '../src/data/plan.js';
import { fixture } from './helpers.js';

describe('TaskCreate / TaskUpdate (Claude Code 2.1.x)', () => {
  const plan = parseSessionBody(fixture('tasks.jsonl'), 't').plan;

  it('reports task-tools as the source', () => {
    expect(plan.source).toBe('task-tools');
  });

  it('numbers tasks by creation order, matching the taskId TaskUpdate uses', () => {
    // The tool_result says "Task #N created successfully" -- N is the ordinal.
    expect(plan.tasks.map((t) => t.id)).toEqual(['1', '2', '3']);
    expect(plan.tasks.map((t) => t.subject)).toEqual(['Scaffold repo', 'Write tests', 'Push']);
  });

  it('applies each TaskUpdate to the task it names', () => {
    expect(plan.tasks.map((t) => t.status)).toEqual(['completed', 'in_progress', 'pending']);
  });

  it('keeps description and activeForm from TaskCreate', () => {
    expect(plan.tasks[0]).toMatchObject({
      description: 'make it',
      activeForm: 'Scaffolding repo',
    });
  });

  it('identifies the task in flight', () => {
    expect(currentTask(plan)?.subject).toBe('Write tests');
  });

  it('reports progress', () => {
    expect(planProgress(plan)).toEqual({ completed: 1, total: 3 });
  });

  it('ignores a TaskUpdate for a task that was never created', () => {
    const body =
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"TaskUpdate","input":{"taskId":"99","status":"completed"}}],"stop_reason":"tool_use"},"timestamp":"2026-09-01T10:00:00.000Z"}';
    expect(() => parseSessionBody(body, 'x')).not.toThrow();
    expect(parseSessionBody(body, 'x').plan.tasks).toEqual([]);
  });

  it('coerces an unrecognised status to pending rather than trusting it', () => {
    const body = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"TaskCreate","input":{"subject":"S"}}],"stop_reason":"tool_use"},"timestamp":"2026-09-01T10:00:00.000Z"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"b","name":"TaskUpdate","input":{"taskId":"1","status":"weird"}}],"stop_reason":"tool_use"},"timestamp":"2026-09-01T10:00:01.000Z"}',
    ].join('\n');
    expect(parseSessionBody(body, 'x').plan.tasks[0]?.status).toBe('pending');
  });
});

describe('TodoWrite fallback (older Claude Code)', () => {
  const plan = parseSessionBody(fixture('todowrite.jsonl'), 'l').plan;

  it('reports todo-write as the source', () => {
    expect(plan.source).toBe('todo-write');
  });

  it('takes the LAST call, since each one carries the whole list', () => {
    expect(plan.tasks).toHaveLength(3);
    expect(plan.tasks.map((t) => t.subject)).toEqual(['Step one', 'Step two', 'Step three']);
    expect(plan.tasks.map((t) => t.status)).toEqual(['completed', 'in_progress', 'pending']);
  });
});

describe('no plan', () => {
  it('reports source "none" for a session that never planned', () => {
    const plan = parseSessionBody(fixture('basic.jsonl'), 'b').plan;
    expect(plan).toEqual({ source: 'none', tasks: [] });
  });
});

describe('precedence', () => {
  it('prefers TaskCreate over TodoWrite when a session used both', () => {
    const body = [
      fixture('todowrite.jsonl').trim(),
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"z","name":"TaskCreate","input":{"subject":"Modern task"}}],"stop_reason":"tool_use"},"timestamp":"2026-09-01T10:00:00.000Z"}',
    ].join('\n');
    const plan = parseSessionBody(body, 'x').plan;
    expect(plan.source).toBe('task-tools');
    expect(plan.tasks.map((t) => t.subject)).toEqual(['Modern task']);
  });
});

describe('taskLabel', () => {
  it('uses the present-tense activeForm while a task is in flight', () => {
    expect(taskLabel({ id: '1', subject: 'Write tests', activeForm: 'Writing tests', status: 'in_progress' })).toBe('Writing tests');
  });

  it('uses the plain subject otherwise', () => {
    expect(taskLabel({ id: '1', subject: 'Write tests', activeForm: 'Writing tests', status: 'pending' })).toBe('Write tests');
    expect(taskLabel({ id: '1', subject: 'Write tests', status: 'completed' })).toBe('Write tests');
  });
});
