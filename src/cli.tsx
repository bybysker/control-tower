import React from 'react';
import { render } from 'ink';
import { Command, InvalidArgumentError } from 'commander';
import { App } from './app.js';
import { SessionCache, loadProjects } from './data/discover.js';
import { GitStateCache } from './data/git.js';
import { SummaryStore, summarySteps } from './data/summarize.js';
import { renderSnapshot } from './data/snapshot.js';
import { resolveClaudeHome } from './utils/paths.js';
import { filterProjects } from './app.js';

interface CliOptions {
  path?: string;
  refreshInterval: number;
  filter?: string;
  watch: boolean;
  git: boolean;
  ai: boolean;
  userTasks: boolean;
  secrets: boolean;
  once: boolean;
}

function parseInterval(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new InvalidArgumentError('must be a non-negative number of milliseconds');
  }
  return n;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('control-tower')
    .description(
      'Supervise every project you run Claude Code in: state, what it needs from you,\n' +
        'where the work got to, what comes next. Local and read-only.',
    )
    .version('0.1.0')
    .option('-p, --path <path>', 'path to the Claude home directory', '$HOME/.claude')
    .option(
      '-r, --refresh-interval <ms>',
      'poll interval in ms (0 = rely on the fs watcher alone)',
      parseInterval,
      2000,
    )
    .option('-f, --filter <pattern>', 'initial filter on project or session title')
    .option('--no-watch', 'disable the fs watcher and poll only')
    .option('--no-git', 'do not read git state from project directories')
    .option('--no-user-tasks', 'do not read .env.example / .env key NAMES for what only you can do')
    .option('--secrets', 'also ask GitHub which repository secrets exist (needs gh and the network)')
    .option(
      '--ai',
      'allow asking Claude for next steps (key A). Sends the tail of a project\u2019s ' +
        'newest session to the Claude API and caches the answer',
    )
    .option('--once', 'print a plain-text snapshot and exit (for scripting)');
  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  program.parse(process.argv);
  const opts = program.opts<CliOptions>();

  // The default is a literal placeholder so --help reads well; resolve it here.
  const rawPath = opts.path === '$HOME/.claude' ? undefined : opts.path;
  const claudeHome = resolveClaudeHome(rawPath);

  if (opts.once) {
    const projects = await loadProjects(claudeHome, new SessionCache(), new Date(), {
      git: opts.git ? new GitStateCache() : undefined,
      userTasks: opts.userTasks,
      checkSecrets: opts.secrets,
    });
    const filtered = opts.filter ? filterProjects(projects, opts.filter) : projects;

    if (opts.ai) {
      // A one-shot command may block; the TUI may not. Requests run in
      // parallel (a few seconds each) and the cache absorbs repeat runs.
      const store = new SummaryStore();
      await store.load();
      await Promise.all(
        filtered.map((p) =>
          store.request(p.dir, p.label, p.path, p.sessions, p.supervision.git, p.lastActivity, () => {}),
        ),
      );
      for (const p of filtered) {
        p.supervision.nextSteps = [...p.supervision.nextSteps, ...summarySteps(store.get(p.dir))];
      }
    }

    process.stdout.write(renderSnapshot(filtered) + '\n');
    return;
  }

  if (!process.stdout.isTTY) {
    process.stderr.write(
      'control-tower: not a TTY — use --once for a plain-text snapshot.\n',
    );
    process.exitCode = 1;
    return;
  }

  const app = render(
    <App
      claudeHome={claudeHome}
      refreshInterval={opts.refreshInterval}
      watch={opts.watch}
      git={opts.git}
      ai={opts.ai ?? false}
      userTasks={opts.userTasks}
      checkSecrets={opts.secrets ?? false}
      initialFilter={opts.filter ?? ''}
    />,
    // Ink's default alt-screen behaviour leaves the terminal scrollback intact.
    { exitOnCtrlC: true },
  );
  await app.waitUntilExit();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `control-tower: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
