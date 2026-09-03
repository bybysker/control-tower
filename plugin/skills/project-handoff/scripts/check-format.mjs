#!/usr/bin/env node
/**
 * Assert that a HANDOFF 1 block is parseable.
 *
 * project-next-steps ships check-contract.mjs so its output contract is not
 * prose-only; this is the same guarantee for the input side. The hazard is
 * specific and upstream does not defend against it: an `ACTION` label is
 * `pendingQuestion.question` verbatim and its `OPTION`s are
 * `pendingQuestion.options` verbatim -- model-authored free text that can
 * contain a newline or a `|`, either of which silently splits one record into
 * two and breaks every parse downstream.
 *
 * Reads a block on stdin, or from the path given as the first argument:
 *
 *   node check-format.mjs briefing.txt
 *   control-tower --handoff teaching-repo | node check-format.mjs
 *
 * Exits 0 when the block is well-formed, 1 with one finding per line otherwise.
 */
import fs from 'node:fs';

const CAPS = { ACTION: 200, OPTION: 80, NOW: 400 };
const ONCE = ['HANDOFF', 'PROJECT', 'PATH', 'STATUS', 'ASOF', 'END'];
const MULTI = { SESSION: 1, ACTION: 4, OPTION: 6, NOW: 1, STEP: 8, GIT: 1, PR: 6, MEMORY: 8 };
const KINDS = ['answer', 'failed', 'unblock', 'reply'];

function read(argvPath) {
  if (argvPath) return fs.readFileSync(argvPath, 'utf8');
  return fs.readFileSync(0, 'utf8');
}

export function check(text) {
  const bad = [];
  const lines = text.replace(/\n$/, '').split('\n');

  if (lines[0] !== 'HANDOFF 1') bad.push(`first line must be "HANDOFF 1", got ${JSON.stringify(lines[0] ?? '')}`);
  if (lines[lines.length - 1] !== 'END') bad.push(`last line must be "END", got ${JSON.stringify(lines[lines.length - 1] ?? '')}`);

  const counts = {};
  let lastRecord = null;

  lines.forEach((line, i) => {
    const n = i + 1;
    if (line.length === 0) return bad.push(`line ${n}: blank lines are not records`);
    const key = line.split(' ')[0];
    if (!/^[A-Z]+$/.test(key)) return bad.push(`line ${n}: not a record — ${JSON.stringify(line.slice(0, 40))}`);
    counts[key] = (counts[key] ?? 0) + 1;

    const value = line.slice(key.length + 1);
    const cap = CAPS[key];
    if (cap !== undefined && value.length > cap) {
      bad.push(`line ${n}: ${key} is ${value.length} chars, cap is ${cap} — the emitter must clamp`);
    }
    // A tab or a stray CR is the same hazard as a newline: it survives the
    // join and breaks a line-oriented parse on the other side.
    if (/[\t\r]/.test(line)) bad.push(`line ${n}: ${key} contains a tab or CR`);

    if (key === 'ACTION') {
      const kind = value.split(' | ')[0];
      if (!KINDS.includes(kind)) bad.push(`line ${n}: ACTION kind ${JSON.stringify(kind)} is not one of ${KINDS.join(', ')}`);
    }
    // An OPTION belongs to the ACTION above it; orphaned, nobody knows what it
    // is a choice for.
    if (key === 'OPTION' && lastRecord !== 'ACTION' && lastRecord !== 'OPTION') {
      bad.push(`line ${n}: OPTION with no ACTION above it`);
    }
    lastRecord = key;
  });

  for (const k of ONCE) {
    if ((counts[k] ?? 0) !== 1) bad.push(`${k} must appear exactly once, appeared ${counts[k] ?? 0}`);
  }
  for (const [k, max] of Object.entries(MULTI)) {
    if ((counts[k] ?? 0) > max) bad.push(`${k} appeared ${counts[k]} times, cap is ${max}`);
  }
  return bad;
}

// Only run when invoked directly, so the checker can also be imported by tests.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const findings = check(read(process.argv[2]));
  if (findings.length === 0) {
    process.stdout.write('HANDOFF block OK\n');
  } else {
    for (const f of findings) process.stdout.write(`! ${f}\n`);
    process.exitCode = 1;
  }
}
