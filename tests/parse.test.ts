import { describe, expect, it } from 'vitest';
import { parseLine, parseSessionBody, resolveSnippet, resolveTitle } from '../src/data/parse.js';
import { fixture } from './helpers.js';

describe('parseLine', () => {
  it('returns null for blank and non-JSON lines', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('   ')).toBeNull();
    expect(parseLine('not json at all')).toBeNull();
  });

  it('returns null for a truncated final line', () => {
    // A file being appended to routinely ends mid-object.
    expect(parseLine('{"type":"assistant","message":{"content":[{"type":"tex')).toBeNull();
  });

  it('skips record types we do not model', () => {
    expect(parseLine('{"type":"bridge-session","sessionId":"x"}')).toBeNull();
    expect(parseLine('{"type":"atis-latch","atis":"","sessionId":"x"}')).toBeNull();
  });

  it('parses a user record whose content is a plain string', () => {
    const rec = parseLine(
      '{"type":"user","message":{"role":"user","content":"hi"},"uuid":"u1","timestamp":"2026-09-01T10:00:00.000Z"}',
    );
    expect(rec?.type).toBe('user');
  });

  it('coerces timestamps to Date', () => {
    const rec = parseLine(
      '{"type":"user","message":{"content":"hi"},"timestamp":"2026-09-01T10:00:00.000Z"}',
    );
    expect(rec && 'timestamp' in rec && rec.timestamp).toBeInstanceOf(Date);
  });
});

describe('parseSessionBody', () => {
  const parsed = parseSessionBody(fixture('basic.jsonl'), 'aaaa1111-0000-0000-0000-000000000001');

  it('counts user + assistant records as turns', () => {
    // 4 substantive records; the queue-operation and the metadata tail are not turns.
    expect(parsed.turnCount).toBe(4);
  });

  it('normalises turns into role/text pairs, flattening newlines', () => {
    expect(parsed.turns.map((t) => t.role)).toEqual([
      'user',
      'assistant',
      'tool_use',
      'tool_result',
      'assistant',
    ]);
    expect(parsed.turns[1]?.text).toBe('On it. Starting now.');
  });

  it('summarises a tool_use by its identifying argument', () => {
    expect(parsed.turns[2]).toMatchObject({ role: 'tool_use', toolName: 'Bash', text: 'Bash: ls -la' });
  });

  it('takes the timestamp of the last record that HAS one', () => {
    // The physical last line is a bridge-session, which carries no timestamp.
    expect(parsed.lastTimestamp?.toISOString()).toBe('2026-09-01T10:00:04.000Z');
    // 10:00:00 belongs to the queue-operation, which we skip entirely.
    expect(parsed.firstTimestamp?.toISOString()).toBe('2026-09-01T10:00:01.000Z');
  });

  it('collects every distinct cwd as a project-path candidate', () => {
    expect(parsed.cwds).toEqual(['/home/alice/code', '/home/alice/code/subdir']);
  });

  it('keeps the LAST occurrence of each title record', () => {
    expect(parsed.aiTitle).toBe('Regenerated title');
    expect(parsed.customTitle).toBe('User pinned title');
  });

  it('records the final stop_reason', () => {
    expect(parsed.lastStopReason).toBe('end_turn');
    expect(parsed.endsMidWork).toBe(false);
  });

  it('reports no malformed lines for a clean file', () => {
    expect(parsed.malformedLines).toBe(0);
  });
});

describe('parseSessionBody resilience', () => {
  const parsed = parseSessionBody(fixture('malformed.jsonl'), 'bbbb');

  it('parses around a bad line instead of throwing', () => {
    expect(parsed.turnCount).toBe(2);
    expect(parsed.turns.map((t) => t.text)).toEqual(['hello', 'hi']);
  });

  it('counts the truncated tail but not the known-ignorable attachment', () => {
    // 'not json at all' does not start with '{' so it is not counted;
    // the truncated assistant line is.
    expect(parsed.malformedLines).toBe(1);
  });

  it('never throws on an empty body', () => {
    const empty = parseSessionBody('', 'cccc');
    expect(empty.turnCount).toBe(0);
    expect(empty.turns).toEqual([]);
    expect(empty.plan.tasks).toEqual([]);
  });
});

describe('title and snippet resolution', () => {
  const parsed = parseSessionBody(fixture('basic.jsonl'), 'aaaa1111-0000-0000-0000-000000000001');

  it('prefers a user-set title over a generated one', () => {
    expect(resolveTitle(parsed)).toBe('User pinned title');
  });

  it('falls back through ai-title, last-prompt, then the session id', () => {
    expect(resolveTitle({ ...parsed, customTitle: undefined })).toBe('Regenerated title');
    expect(resolveTitle({ ...parsed, customTitle: undefined, aiTitle: undefined })).toBe(
      'Bootstrap the thing',
    );
    expect(
      resolveTitle({
        ...parsed,
        customTitle: undefined,
        aiTitle: undefined,
        lastPrompt: undefined,
      }),
    ).toBe('aaaa1111');
  });

  it('uses the last assistant text as the snippet', () => {
    expect(resolveSnippet(parsed)).toBe('Done.');
  });
});

describe('tool_result error handling', () => {
  it('treats only is_error === true as an error', () => {
    const parsed = parseSessionBody(fixture('basic.jsonl'), 'x');
    const result = parsed.turns.find((t) => t.role === 'tool_result');
    expect(result?.isError).toBe(false);
    expect(parsed.lastToolErrored).toBe(false);
  });

  it('does not treat a missing is_error as a failure', () => {
    const line =
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"out"}]},"timestamp":"2026-09-01T10:00:00.000Z"}';
    const parsed = parseSessionBody(line, 'x');
    expect(parsed.lastToolErrored).toBe(false);
  });

  it('flags a declined permission prompt separately from a real failure', () => {
    const parsed = parseSessionBody(fixture('rejected.jsonl'), 'r');
    expect(parsed.lastToolErrored).toBe(true);
    expect(parsed.lastToolRejectedByUser).toBe(true);
  });
});

describe('transcript tail bounding', () => {
  it('retains only the last N turns', () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(
        `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"line ${i}"}],"stop_reason":"end_turn"},"timestamp":"2026-09-01T10:00:00.000Z"}`,
      );
    }
    const parsed = parseSessionBody(lines.join('\n'), 'big', { tailLimit: 10 });
    expect(parsed.turnCount).toBe(500); // full file still counted
    expect(parsed.turns).toHaveLength(10);
    expect(parsed.turns.at(-1)?.text).toBe('line 499');
  });
});
