import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverSessionFiles, groupByProject, toSession } from '../src/data/discover.js';
import { parseSessionBody } from '../src/data/parse.js';
import { fixture } from './helpers.js';

async function makeStore(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-test-'));
  const projects = path.join(root, 'projects');

  // A normal project with two sessions.
  const p1 = path.join(projects, '-home-alice-code');
  await fs.mkdir(p1, { recursive: true });
  await fs.writeFile(path.join(p1, 'aaaa1111-0000-0000-0000-000000000001.jsonl'), fixture('basic.jsonl'));
  await fs.writeFile(path.join(p1, 'bbbb2222-0000-0000-0000-000000000002.jsonl'), fixture('tasks.jsonl'));

  // Subagent transcripts and spilled tool results must NOT count as sessions.
  const sub = path.join(p1, 'aaaa1111-0000-0000-0000-000000000001', 'subagents');
  await fs.mkdir(sub, { recursive: true });
  await fs.writeFile(path.join(sub, 'agent-abc123.jsonl'), fixture('basic.jsonl'));
  await fs.writeFile(path.join(sub, 'agent-abc123.meta.json'), '{}');

  // A project directory holding only memory/ is not a project.
  const p2 = path.join(projects, '-home-alice-code-archive', 'memory');
  await fs.mkdir(p2, { recursive: true });
  await fs.writeFile(path.join(p2, 'MEMORY.md'), '- note\n');

  return root;
}

describe('discoverSessionFiles', () => {
  it('finds only .jsonl sitting directly inside a project directory', async () => {
    const root = await makeStore();
    const files = await discoverSessionFiles(root);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.sessionId).sort()).toEqual([
      'aaaa1111-0000-0000-0000-000000000001',
      'bbbb2222-0000-0000-0000-000000000002',
    ]);
  });

  it('never picks up subagent transcripts as sessions', async () => {
    const root = await makeStore();
    const files = await discoverSessionFiles(root);
    expect(files.some((f) => f.filePath.includes('subagents'))).toBe(false);
  });

  it('returns empty rather than throwing when there is no store', async () => {
    expect(await discoverSessionFiles('/nonexistent/path/xyz')).toEqual([]);
  });
});

describe('groupByProject', () => {
  it('omits a project directory that holds no sessions', async () => {
    const root = await makeStore();
    const files = await discoverSessionFiles(root);
    const sessions = await Promise.all(
      files.map(async (f) =>
        toSession(f, parseSessionBody(await fs.readFile(f.filePath, 'utf8'), f.sessionId)),
      ),
    );
    const projects = groupByProject(sessions);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.dir).toBe('-home-alice-code');
    expect(projects[0]?.sessions).toHaveLength(2);
  });

  it('names the project from the cwd that re-encodes to its directory', async () => {
    const root = await makeStore();
    const files = await discoverSessionFiles(root);
    const sessions = await Promise.all(
      files.map(async (f) =>
        toSession(f, parseSessionBody(await fs.readFile(f.filePath, 'utf8'), f.sessionId)),
      ),
    );
    // basic.jsonl's LAST cwd is .../subdir -- that must not name the project.
    expect(groupByProject(sessions)[0]?.path).toBe('/home/alice/code');
  });
});

describe('toSession', () => {
  it('uses file mtime when it is later than the last timestamped record', () => {
    const parsed = parseSessionBody(fixture('basic.jsonl'), 'a');
    const mtime = new Date('2027-01-01T00:00:00.000Z');
    const session = toSession(
      { filePath: '/x/a.jsonl', projectDir: '-x', sessionId: 'a', size: 1, mtime },
      parsed,
    );
    // Metadata records carry no timestamp and are often last, so the file can
    // legitimately be newer than the newest timestamped record.
    expect(session.lastActivity).toEqual(mtime);
  });
});
