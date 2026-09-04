# Control Tower — the full guide

The README is the short version. This is everything else it used to say.

## What it shows

One framed dashboard, everything at once. `↑↓` moves the selection in
**Projects**; the other three panels follow it.

The README shows the framed dashboard. In a pipe, `--once` prints the same
facts as text — this is the demo store from `scripts/demo-store.py`:

```
control-tower: 4 projects, 6 sessions, 5 need you, 1 on you

! action   shop-api                 feature/oauth2 · dirty · ↑2  2m  /tmp/alice/code/shop-api
  ! fix       FAIL tests/auth.spec.ts — expected 200, received 401. 3 failed, 41 passed.  (a1b2c3d4)
  ! unblock   Edit is waiting for a result -- permission prompt, or the process died  (a1b2c3d4)
  ▲ you       Get STRIPE_SECRET_KEY and put it in .env
  △ you       3 other .env keys have no value — an agent can fill them from .env.example
    now       Token store extracted, 41 tests green. Wiring the OAuth2 provider next.
    next      ● Wiring the OAuth2 provider | ○ Write the integration tests | ○ Remove the legacy middleware | → Commit or s…
    ○ idle        2m OAuth2 migration + tests                     Token store extracted, 41 tests green. Wiring the…
    ✗ failed     28m Test suite after the refactor                Bash: npm test -- --runInBand

! action   dashboard                main  9m  /tmp/alice/code/dashboard
  ! unblock   Bash is waiting for a result -- permission prompt, or the process died  (a1b2c3d4)
    now       Checking what webpack emits as chunks.
    ○ idle        9m Dashboard bundle size                        Checking what webpack emits as chunks.
    ✓ done        5h Header jumps on scroll                       It is `position: sticky` inside a parent with `ov…

! action   infra                    migration/postgres  PR #44  14m  /tmp/alice/code/infra
  ! answer    The Cloud Build trigger has run once, on main only, and its branch filter is unverified. If it is `.*`, pushi…  (a1b2c3d4)
  △ you       Get GCP_CREDENTIALS_PATH and put it in .env
    now       Schema migrated, tests green on SQLite and Postgres. The push is left: the Cloud Build trigger may deploy on …
    next      ○ Open the PR | → Land migration/postgres — clean and pushed, still off trunk
    ○ idle       14m Postgres migration + PR                      Schema migrated, tests green on SQLite and Postgr…

! action   data-pipeline            spot-instances · dirty  3d  /tmp/alice/code/data-pipeline
  ! unblock   Bash is waiting for a result -- permission prompt, or the process died  (a1b2c3d4)
    next      → Commit or stash 3 changed files | → Publish branch spot-instances — it has no upstream
    … stalled     3d Staging cluster on spot instances            Bash: terraform plan -out=staging.tfplan
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

Every action carries a second line saying **which session** you have to go to —
its title, `cli` or `claude-desktop`, when it started, its working directory and
its short id, all of them things the transcript recorded about itself:

```
  fix      FAIL tests/auth.spec.ts — expected 200, received 401. 3 failed.   25m
           ↳ Test suite after the refactor · cli · started 26m ago · …/code/shop-api · #a1b2c3d4
```

In the project view `↑↓` walks the actions before the sessions, and `⏎` on an
action opens that session's transcript **at the turn the action is about**,
quoting it above the stream: for `fix`, the command and the error text in full;
for `unblock`, the call still waiting and its arguments. On a terminal short
enough that the quote would crowd out the transcript, the quote is dropped and
the scroll position alone does the work.

That is where it stops. `answer`, `reply` and `unblock` are a live process in
another terminal, and nothing on disk says whether it is still alive — so
Control Tower never resumes, answers or retries. It tells you which window and
what is waiting there.

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
| `↑↓` `jk` projects | `↑↓` `jk` actions, then sessions | `↑↓` `jk` scroll |
| `⏎` `l` open | `⏎` `l` transcript (at the action's turn) | |
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

In a pipe, `--once` is grep-friendly: every action line starts with `  !`, every
project line carries its status as a bare word. On a terminal it paints the
real dashboard once, in colour; `--plain` forces the text form there too.

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
