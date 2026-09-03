#!/usr/bin/env node
/**
 * Regression check for the project-next-steps skill.
 *
 * Runs every envelope in references/fixtures/ through the real invocation --
 * same flags, same model, same one turn as SummaryStore.request() -- then
 * through a copy of parseSteps() from src/data/summarize.ts, and asserts the
 * output contract SKILL.md promises.
 *
 * The point is that the contract is checked against what the model ACTUALLY
 * emits on haiku, not against what SKILL.md says. Any edit to SKILL.md should
 * be re-run through this before it is committed.
 *
 *   node plugin/skills/project-next-steps/scripts/check-contract.mjs
 *   node .../check-contract.mjs rag-eval        # one fixture
 *
 * Costs four `claude -p` calls on haiku, about 2 minutes. Exit code 1 on any
 * violation, so it can gate a commit.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..');
const PLUGIN_DIR = path.resolve(SKILL_DIR, '..', '..');
const FIXTURES = path.join(SKILL_DIR, 'references', 'fixtures');

/** Verbatim from src/data/summarize.ts -- if that changes, change this. */
const MAX_STEPS = 3;
function parseSteps(stdout) {
  const lines = stdout
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0 || lines[0]?.toUpperCase() === 'NONE') return [];
  return lines.filter((l) => l.toUpperCase() !== 'NONE').slice(0, MAX_STEPS);
}

/**
 * The vocabulary gitSteps() already owns, in every wording it renders:
 * "Commit or stash", "Push N commits", "Publish branch — no upstream",
 * "Land <branch> — still off trunk", "Pull N commits", "untracked — add or
 * ignore". A step saying any of it is a duplicate of a line Control Tower is
 * already showing, deterministically, right next to this one.
 *
 * Deliberately NOT banned, because gitSteps() cannot derive them and they can
 * be real work: a bare "PR" (addressing review comments is not a git chore),
 * and "review" on its own. Only PR *creation* is banned -- that is the "land"
 * step wearing a different hat.
 */
const BANNED = new RegExp(
  [
    '\\b(commit|stash|push(ed|ing)?|pull(ing)?|fetch|rebase|merge|merging)\\b',
    '\\b(land|ship|publish)\\b',
    '\\bupstream\\b',
    '\\b(open|create|raise|submit)\\s+(a|the)?\\s*(PR|pull request|merge request)\\b',
    '\\bgit add\\b',
    '\\buntracked\\b',
  ].join('|'),
  'i',
);
const PREAMBLE = /^(here|these|below|sure|okay|ok\b|let me|i (will|'ll|can)|based on|the next)/i;
/**
 * Markdown that would reach the panel verbatim. Backticks are included on
 * purpose: the Next-steps panel is plain text, so a step written as
 * "Run `make eval`" renders with the backticks showing.
 */
const MARKUP = /(^```|^#{1,6}\s|\*\*|`|^\||^>\s)/;

/** Fixture-specific rules: what this particular case must and must not say. */
const EXTRA = {
  'demo-app': (steps) =>
    steps.length === 0 ? [] : ['a dormant clean project must answer exactly NONE'],
  'teaching-repo': (steps) =>
    steps
      .filter((s) =>
        /instructor/i.test(s) ||
        /\b(brief|hint|indice|solution|correction|trou|todo student)\b/i.test(s),
      )
      .map((s) => `bootcamp rule: touches the instructor branch or adds hints -- ${s}`),
  'chat-bot': (steps) =>
    steps.length === 0 ? ['a session mid-wiring should yield at least one step'] : [],
  'rag-eval': (steps) =>
    steps.length === 0 ? ['a session with a stale eval should yield at least one step'] : [],
};

/**
 * The runner directory Control Tower's discovery skips.
 *
 * `claude -p` writes a session in its cwd, so a checker that ran in a fresh
 * mkdtemp created one project directory PER RUN in ~/.claude/projects -- this
 * script alone left sixteen of them, and Control Tower then reported them as
 * projects. Mirrors summaryRunnerDir() in src/utils/paths.ts; the two must
 * agree, which is why the suffix, not the whole path, is what discovery tests.
 */
function runnerDir() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'control-tower', 'runner');
}

function run(envelope) {
  const cwd = runnerDir();
  fs.mkdirSync(cwd, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      [
        '-p',
        '--plugin-dir', PLUGIN_DIR,
        '--model', 'haiku',
        '--max-turns', '1',
        `/project-next-steps\n${envelope}`,
      ],
      { cwd, timeout: 120_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
    // `stdio` is ignored by execFile -- the child still gets a live stdin and
    // waits on it. Closing the handle is what actually stops the wait.
    child.stdin?.end();
  });
}

function violations(name, raw) {
  const steps = parseSteps(raw);
  const out = [];
  if (steps.length > MAX_STEPS) out.push(`${steps.length} steps, max is ${MAX_STEPS}`);
  if (/^\s*(?:the |here|okay|sure)/i.test(raw) && steps.length > 0) out.push('reply opens with prose');
  for (const s of steps) {
    if (s.length >= 70) out.push(`${s.length} chars (limit 70): ${s}`);
    if (BANNED.test(s)) out.push(`git chore already derived by gitSteps(): ${s}`);
    if (PREAMBLE.test(s)) out.push(`preamble parsed as a step: ${s}`);
    if (MARKUP.test(s)) out.push(`markdown survived the parser: ${s}`);
  }
  out.push(...(EXTRA[name]?.(steps) ?? []));
  return { steps, out };
}

const only = process.argv[2];
const files = fs
  .readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.txt'))
  .filter((f) => !only || f.startsWith(only));

if (files.length === 0) {
  console.error(`no fixture matching "${only}" in ${FIXTURES}`);
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  const name = file.replace(/\.txt$/, '');
  const envelope = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
  const t0 = Date.now();
  let raw;
  try {
    raw = await run(envelope);
  } catch (e) {
    console.log(`FAIL  ${name}  invocation failed: ${String(e.message).slice(0, 120)}`);
    failed++;
    continue;
  }
  const { steps, out } = violations(name, raw);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(
    `${out.length ? 'FAIL' : 'PASS'}  ${name.padEnd(22)} ${steps.length} step(s)  ${secs}s`,
  );
  for (const s of steps) console.log(`        (${String(s.length).padStart(2)}) ${s}`);
  for (const v of out) console.log(`        ! ${v}`);
  if (out.length) failed++;
}

console.log(failed ? `\n${failed}/${files.length} failing` : `\n${files.length}/${files.length} green`);
process.exit(failed ? 1 : 0);
