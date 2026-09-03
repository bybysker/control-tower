# Control Tower

A local, read-only TUI that supervises every project you are running
[Claude Code](https://claude.com/claude-code) in: what state it is in, what it
needs from you, where the work got to, and what comes next.

It reads the transcripts Claude Code already writes under `~/.claude/projects`
(plus, optionally, `git status` in each project directory). No cloud, no
account, no hooks, nothing written anywhere.

```
control-tower: 4 projects, 7 sessions, 4 need you

! action   acme-api                 now  /home/alice/code/acme-api
  ! fix       FAIL tests/auth.spec.ts - Expected 200, received 401. 3 failed, 41 passed.  (22222222)
    now       Le token store est extrait. J'attaque le provider OAuth2 maintenant.
    next      ● Wiring the OAuth2 provider | ○ Ecrire les tests d'integration | ○ Supprimer l'ancien middleware
    ● running    now Migration OAuth2 + tests                     Le token store est extrait. J'attaque le provider…
    ✗ failed     17h Suite de tests apres refacto                 Bash: npm test -- --runInBand

! action   acme-infra               PR #44  11h  /home/alice/code/acme-infra
  ! answer    Le trigger Cloud Build est récent et n'a tourné qu'une fois sur main ; si son filtre est `.*`, pousser migrat…  (77777777)
    now       Schéma migré, tests verts sur SQLite et Postgres. Il reste le push : le trigger Cloud Build déploie peut-être…
    next      ● Pushing migration/postgres | ○ Ouvrir la PR
    … stalled    11h Migration Postgres + PR                      Schéma migré, tests verts sur SQLite et Postgres.…
```

## Install

Requirements: **Node 20+**, **git**, and [Claude Code](https://claude.com/claude-code)
installed and used at least once (Control Tower reads the sessions it writes
under `~/.claude`). macOS and Linux.

Install the release tarball — one command, no clone:

```sh
npm install -g https://github.com/bybysker/control-tower/releases/download/v0.1.0/control-tower-0.1.0.tgz
control-tower
```

Try it without installing anything:

```sh
npx github:bybysker/control-tower --once
```

From source, if you want to hack on it — `dist/` is committed, so it runs right
after the clone:

```sh
git clone https://github.com/bybysker/control-tower && cd control-tower
npm install
./dist/cli.js          # the TUI
./dist/cli.js --once   # the same thing as plain text, for pipes
npm run build          # after editing src/
npm link               # optional: `control-tower` on your PATH
```

> Why a tarball and not `npm install -g github:…`? Because that form is broken
> on npm 10.8 (the one bundled with Node 20): it links the global package to a
> temporary clone in npm's cache, which is then deleted — you get an entry with
> no version and no binary. Measured, not assumed. `npx github:…` takes a
> different path and works.

Uninstall with `npm uninstall -g control-tower`. It leaves one thing behind
only if you used `--ai`: a small cache under `~/.cache/control-tower`.

### What it reads, and what it never touches

It reads `~/.claude/projects/**/*.jsonl` (Claude Code's own transcripts), runs
`git status` in each project directory, and reads **key names only** from
`.env.example` / `.env`. It never writes inside `~/.claude`, never resumes,
kills, or edits a session, and never leaves your machine unless you pass
`--ai` or `--secrets`. Every read outside `~/.claude` has an opt-out; the table
is in [CLAUDE.md](CLAUDE.md#boundaries-the-tool-advertises).

## What it shows

One framed dashboard, everything at once. `↑↓` moves the selection in
**Projects**; the other three panels follow it.

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ∴ Control Tower  …/demo-store      Projects 4 · Sessions 7 · Needs you 4 · Running 1 │
│ ● NEEDS YOU  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  1/3 │
├──────────────────────────────────────────────┬───────────────────────────────────────┤
│ Active Project  acme-infra                   │ Projects                            4 │
│                                              │                                       │
│ status  ! action   1 session · 11h ago       │ ! acme-api                         3s │
│ path    /home/alice/code/acme-infra   │ ! acme-infra             PR #44   11h │
│ PR      #44  https://github.com/bybysker/ac… │ ! acme-web                        17h │
│                                              │ ! infra                            4d │
│ Needs you  1                                 │                                       │
│   answer   Le trigger Cloud Build est r… 11h ├───────────────────────────────────────┤
│            [Pousser (trigger main-only)]  [… │ Activity                     1-4 of 7 │
│                                              │                                       │
│ Where we are  11h ago                        │   3s ago  acme-api       ● Migration… │
│ ┃ Schéma migré, tests verts sur SQLite et    │  11h ago  acme-infra     … Migration… │
│ ┃ Postgres. Il reste le push : le trigger    │  17h ago  acme-web       … Reduction… │
│   … 9 more lines — ⏎ to open                 │  17h ago  acme-api       ✗ Suite de … │
├──────────────────────────────────────────────┴───────────────────────────────────────┤
│ Latest Session  #77777777  Migration Postgres + PR    … stalled · 11h ago · 14 turns │
│                                                                                      │
│ TaskUpdate   #2 in_progress                                                          │
│   ✓ ok                                                                               │
│ ∴ Schéma migré, tests verts sur SQLite et Postgres. Il reste le push : le trigger C… │
│ › vérifie le trigger avant                                                           │
│ AskUserQues… Le trigger Cloud Build est récent et n'a tourné qu'une fois sur main ;… │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ↑↓ Projects   ⏎ Open   / Filter   R Refresh   Q Quit                                 │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| Panel | What it answers |
|---|---|
| header | how much is going on: projects, sessions, things waiting on you, sessions running; then the selected project's progress (plan tasks done, or sessions done) |
| **Active Project** | the selected project: status, git branch · dirty · ↑ahead ↓behind, PR, then *Needs you*, *Where we are* (Claude's last words), *Next* (in-progress and pending tasks), *Memory* (its `memory/MEMORY.md` notes) |
| **Projects** | every project, sorted by what needs attention then recency: `!` action · `✗` failed · `●` running · `○` idle · `✓` done · `…` stalled |
| **Activity** | the most recent sessions across all projects |
| **Latest Session** | the selected project's newest transcript as a stream: tool calls in bold, `✓`/`✗` results, `∴` Claude, `›` you |

`⏎` opens the project in full (every action with its options, PRs, memory,
sessions); `⏎` again opens a session's plan and transcript.

### Actions

Nothing moves in a project until you do one of these. Highest certainty first.

| Kind | Read from | Certainty |
|---|---|---|
| `answer` | an `AskUserQuestion` Claude asked and never got a result for — question and options shown verbatim | certain |
| `fix` | the last tool call errored | high |
| `unblock` | a tool call still waiting past 10 s — usually a permission prompt, sometimes a dead process; the label says both | probable |
| `reply` | Claude's last words end in `?`, in the project's newest session only | moderate |

A permission prompt you declined is not an action: you already answered. A
`reply` from an older session is not either: you moved on. Anything older than
seven days drops off the card.

### Your turn

Some work cannot be delegated at all: an agent with the whole repository still
cannot log into Meta's dashboard, hold a credit card, or click an OAuth consent.
That is a different thing from an *action* — an action is a session waiting on
your answer; this is a task the world requires of you before anything runs.

| Glyph | Means |
|:--:|---|
| `▲` | Blocking: there is no `.env` at all, or CI references a secret that does not exist |
| `△` | Not blocking, or delegable |

Two deterministic sources:

- **`env`** — `.env.example` declares what the project expects; `.env` says what
  is still unset or still a placeholder.
- **`ci`** — a workflow references `secrets.X`; `gh secret list` says whether X
  exists. Off by default (`--secrets`), because it needs the network.

**The split is the point.** Listing every unset variable buries the four that
need a browser under twenty that do not, so keys that name an externally-issued
credential (`ANTHROPIC_API_KEY`, `WA_ACCESS_TOKEN`, `GOOGLE_CLIENT_SECRET`,
`AZURE_WEBAPP_PUBLISH_PROFILE`) are listed one by one as yours, and the rest —
`LOG_LEVEL`, `APP_PORT`, `POSTGRES_HOST` — collapse into a single line marked
delegable, because an agent fills those from the example file.

```
✓ done     chat-bot    fix/finish-wiring · dirty  3d
  ▲ you       Get WA_ACCESS_TOKEN and put it in .env
  ▲ you       Get WA_APP_SECRET and put it in .env
  ▲ you       Get ANTHROPIC_API_KEY and put it in .env
  △ you       16 other .env keys have no value — an agent can fill them from .env.example
```

#### Names leave, values never do

A `.env` holds live credentials, so Control Tower reads **key names only**. The
value of an assignment is inspected for one thing — is it empty or an obvious
placeholder — and then discarded; it never reaches a data structure, the screen,
the cache, or the API. A test plants a sentinel secret and asserts it appears in
none of them. Turn the whole thing off with `--no-user-tasks`.

### Next steps

Three sources, glyphed apart because they differ in what they know.

| Glyph | Source | What it is |
|:--:|---|---|
| `✓ ● ○` | **plan** | `TaskCreate`/`TaskUpdate` — what Claude itself said it would do. The best signal, when it exists: on the machine this was built against, 2 sessions out of 18. |
| `→` | **git** | What the repository state implies: uncommitted files, unpushed commits, a branch with no upstream, one still off trunk. Always available, deterministic, mechanical. |
| `∴` | **ai** | Opt-in (`--ai`). The `project-next-steps` skill reads the tail of the project's newest session and names up to three steps. Not deterministic — a guess, marked as one. |

Git steps are ordered by how close each is to losing work: commit, then push,
then land, then pull. Untracked files are mentioned only when nothing else is
outstanding, because they are usually build output.

Prose is deliberately *not* a source. Transcripts phrase next steps in French
and English under half a dozen headings, in 4 sessions out of 18 — too little
signal and too much noise to put in front of you as a to-do list.

#### `--ai`, and what it costs

`--ai` is the only feature that leaves your machine, and the only one that
writes anything. It is never automatic:

- Press **`A`** on a project. Nothing runs until you do.
- It sends the tail of that project's newest session (bounded, ~4 KB) to the
  Claude API through the `claude` CLI, on `haiku`, invoking the
  `project-next-steps` skill from `plugin/`. Measured at just over a minute per
  project — the skill expands into the prompt, which is what buys the archetype
  awareness and the contract that survives a small model.
- The answer is cached under `$XDG_CACHE_HOME/control-tower` and reused until
  the project actually moves. Nothing is ever written inside `~/.claude`.
- `claude -p` writes a session wherever it runs, so the summariser runs in a
  directory of its own that discovery skips — summarising a project never adds
  a session to it. Discovery matches that directory by its `-control-tower-runner`
  suffix, so a runner made under any cache root is skipped, not just the current one.
- The model's output is displayed as text and nothing else. Transcripts can
  contain text from web pages and tool results, so a summary is treated as
  untrusted data, never as instructions.

`--once --ai` fills every project in parallel, then serves from cache.

### Statuses are deductions

Claude Code writes no status. `running` means "written in the last 10 s and
the transcript ends mid-work"; `done` means "the last turn closed cleanly", not
"succeeded". The full rules and their known failure modes are in
[docs/status-heuristics.md](docs/status-heuristics.md).

## Keys

| Dashboard | Project | Session |
|---|---|---|
| `↑↓` `jk` projects | `↑↓` `jk` sessions | `↑↓` `jk` scroll |
| `⏎` `l` open | `⏎` `l` transcript | |
| `/` filter · `a` next steps (`--ai`) | `esc` `h` back | `esc` `h` back |
| `r` rescan · `q` quit | `r` · `q` | `r` · `q` |

While typing a filter, `q` is a letter; `esc` cancels, `⏎` applies.

## Options

```
-p, --path <path>            Claude home (default: ~/.claude)
-r, --refresh-interval <ms>  poll interval, 0 = fs watcher only (default: 2000)
-f, --filter <pattern>       initial filter
--no-watch                   poll only
--no-git                     do not read git state from project directories
--no-user-tasks              do not read .env key names for what only you can do
--secrets                    also ask GitHub which repository secrets exist
--ai                         allow asking Claude for next steps (key A)
--once                       print a plain-text snapshot and exit
```

`--once` is grep-friendly: every action line starts with `  !`, every project
line carries its status as a bare word.

```sh
control-tower --once | grep '^  !'        # everything waiting on you
control-tower --once | grep -c running    # how much is working right now
control-tower --once | grep '^  ▲'        # what is blocked on you
```

## How it reads Claude Code

Reverse-engineered on a real machine, not from documentation — there is none,
and `claude sessions list` is not a command (it runs as a prompt). The format
is in [docs/data-source.md](docs/data-source.md). The parts that matter most:

- One session is one `<uuid>.jsonl` directly inside a project directory.
  `subagents/` transcripts and `memory/` are not sessions.
- The project directory name is lossy (`/` and `.` both become `-`); the real
  path is recovered by re-encoding the `cwd` values found inside.
- The plan is `TaskCreate` / `TaskUpdate` (Claude Code 2.1.x). `TodoWrite` is
  supported as a fallback but does not appear on 2.1.x machines.
- Over a third of record types carry no timestamp; the last *timestamped*
  record and the file mtime are cross-checked.

Everything is validated with permissive schemas: unknown record types are
skipped, a half-written last line is dropped, and the tool never crashes on a
transcript being appended to.

## Development

```sh
npm run dev          # tsx, no build
npm test             # vitest, < 1 s
npm run lint && npm run typecheck && npm run build
```

Read-only by design: it never resumes, kills, or writes to a session. The only
exception is `--ai`, which is opt-in and documented above.

## The plugin

`plugin/` ships two skills and one agent that operate the supervision workflow —
see [plugin/README.md](plugin/README.md). `project-next-steps` is what `--ai`
invokes. The other two are for you:

```sh
claude --plugin-dir "$(npm root -g)/control-tower/plugin"   # or the path of your clone
```

then `/project-handoff` to resume a project from its supervision state, or ask
for the `triage` agent to rank every project against every other one.
