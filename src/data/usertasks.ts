import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { UserTask } from './types.js';

/**
 * What only the human can do.
 *
 * Control Tower's `actions` are sessions that stopped and are waiting on an
 * answer. These are different: nobody can delegate them, because they need a
 * browser login, a credit card, a console click or a legal consent. An agent
 * given the whole repository still cannot create an API key.
 *
 * Two deterministic sources, both read-only:
 *
 *   env  a `.env.example` (or `.sample` / `.template`) declares the variables
 *        the project expects; the real `.env` says which are still unset.
 *   ci   a GitHub Actions workflow references `secrets.X`; `gh secret list`
 *        says whether X exists on the repository.
 *
 * A third source, `ai`, is opt-in and only ever adds WHERE to go — it never
 * invents a task.
 *
 * PRIVACY, and it is the whole design: a `.env` holds live credentials. This
 * module reads NAMES ONLY. `readKeys()` returns the left-hand side of each
 * assignment and discards the value before it is ever held, so no secret
 * reaches a data structure, the screen, a cache, or the API. The only fact
 * derived from a value is whether it was empty.
 */

const EXAMPLE_NAMES = ['.env.example', '.env.sample', '.env.template', 'env.example'];
const ENV_NAMES = ['.env', '.env.local'];
const GIT_TIMEOUT_MS = 5_000;

/** `KEY=value` → `KEY`, and whether the value was non-empty. Values are dropped here. */
function parseAssignments(body: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    // The value is inspected for emptiness and then goes out of scope. It is
    // never returned, logged, or stored.
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    const filled = value.length > 0 && !/^(changeme|xxx+|your[-_ ]?|<.*>|\.\.\.)$/i.test(value);
    out.set(key, out.get(key) === true ? true : filled);
  }
  return out;
}

async function readFirst(dir: string, names: string[]): Promise<string | undefined> {
  for (const n of names) {
    try {
      return await fs.readFile(path.join(dir, n), 'utf8');
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Does this key require a human, or can an agent fill it?
 *
 * The split is the point of this module. Listing every unset variable buries
 * the four that need a browser under twenty that do not: nobody needs to be
 * told that LOG_LEVEL, APP_PORT or POSTGRES_HOST is unset — an agent reads the
 * example file and fills them. What an agent cannot do is log into Meta's
 * dashboard, hold a credit card, or click an OAuth consent.
 *
 * A key is human-only when it names a credential issued by an external party.
 * Deliberately NOT here: `POSTGRES_PASSWORD` and friends, which an agent
 * generates for a local compose stack.
 */
const HUMAN_ONLY =
  /(_API_KEY|_ACCESS_TOKEN|_APP_SECRET|_SECRET_KEY|_PUBLIC_KEY|_PRIVATE_KEY|_CLIENT_ID|_CLIENT_SECRET|_VERIFY_TOKEN|_PUBLISH_PROFILE|_CREDENTIALS|_CREDENTIALS_PATH|_ACCESS_KEY|_PHONE_NUMBER_ID|_DSN|_WEBHOOK_URL|_ENDPOINT|_MEASUREMENT_ID)$/;

export function isHumanOnly(key: string): boolean {
  return HUMAN_ONLY.test(key);
}

function envTask(key: string, blocking: boolean): UserTask {
  return {
    source: 'env',
    id: `env-${key}`,
    key,
    label: `Get ${key} and put it in .env`,
    blocking,
  };
}

export interface EnvFinding {
  /** Keys the example declares that the real file does not satisfy. */
  missing: string[];
  /** True when there is no .env at all: nothing runs. */
  noEnvFile: boolean;
  /** True when the project declares no expectations, so there is nothing to say. */
  noExample: boolean;
}

export async function readEnvFinding(projectPath: string): Promise<EnvFinding> {
  const example = await readFirst(projectPath, EXAMPLE_NAMES);
  if (example === undefined) return { missing: [], noEnvFile: false, noExample: true };
  const expected = [...parseAssignments(example).keys()];
  const actual = await readFirst(projectPath, ENV_NAMES);
  if (actual === undefined) return { missing: expected, noEnvFile: true, noExample: false };
  const have = parseAssignments(actual);
  return {
    missing: expected.filter((k) => have.get(k) !== true),
    noEnvFile: false,
    noExample: false,
  };
}

/** Secret names referenced by workflows, minus the one GitHub always provides. */
export function referencedSecrets(workflowBodies: string[]): string[] {
  const found = new Set<string>();
  for (const body of workflowBodies) {
    for (const m of body.matchAll(/secrets\.([A-Z_][A-Z0-9_]*)/g)) {
      const name = m[1];
      if (name && name !== 'GITHUB_TOKEN') found.add(name);
    }
  }
  return [...found].sort();
}

async function readWorkflows(projectPath: string): Promise<string[]> {
  const dir = path.join(projectPath, '.github', 'workflows');
  try {
    const names = await fs.readdir(dir);
    return await Promise.all(
      names
        .filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))
        .map((n) => fs.readFile(path.join(dir, n), 'utf8')),
    );
  } catch {
    return [];
  }
}

/** `gh secret list` names. Undefined when gh is absent, unauthenticated, or offline. */
function listSecrets(cwd: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['secret', 'list', '--json', 'name', '-q', '.[].name'],
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(undefined);
        resolve(stdout.split('\n').map((l) => l.trim()).filter(Boolean));
      },
    );
  });
}

export interface UserTaskOptions {
  /** Query GitHub for which secrets exist. Off by default: it needs the network. */
  checkSecrets?: boolean;
}

export async function deriveUserTasks(
  projectPath: string | undefined,
  options: UserTaskOptions = {},
): Promise<UserTask[]> {
  if (!projectPath) return [];
  const out: UserTask[] = [];

  const env = await readEnvFinding(projectPath);
  const human = env.missing.filter(isHumanOnly);
  const delegable = env.missing.filter((k) => !isHumanOnly(k));

  // Blocking means the project cannot run at all, which is what a missing
  // .env implies -- not merely that one credential is unset.
  for (const key of human) out.push(envTask(key, env.noEnvFile));

  // The rest is one line, not twenty: it is work, but not YOUR work.
  if (delegable.length > 0) {
    out.push({
      source: 'env',
      id: 'env-delegable',
      label:
        `${delegable.length} other .env ${delegable.length === 1 ? 'key has' : 'keys have'} no value ` +
        `— an agent can fill ${delegable.length === 1 ? 'it' : 'them'} from .env.example`,
      blocking: false,
      delegable: true,
    });
  }

  if (options.checkSecrets) {
    const referenced = referencedSecrets(await readWorkflows(projectPath));
    if (referenced.length > 0) {
      const have = await listSecrets(projectPath);
      // Undefined means we could not ask. Claiming a secret is missing because
      // gh is not installed would be worse than saying nothing.
      if (have) {
        for (const name of referenced.filter((n) => !have.includes(n))) {
          out.push({
            source: 'ci',
            id: `ci-${name}`,
            key: name,
            label: `Add the repository secret ${name} — CI references it`,
            blocking: true,
          });
        }
      }
    }
  }
  return out;
}
