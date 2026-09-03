# Control Tower — working notes

A local, read-only TUI that supervises every project you run Claude Code in.
Reads `~/.claude/projects/**/*.jsonl` and `git status`. `README.md` says what it
does; this file says what will bite you.

Everything below was found empirically, usually by a bug. None of it is
guessable from the code, and most of it looks like a bug in our own code when
it recurs.

## Before you claim a UI change works

Run the binary under a pty and **measure every row**. Not a screenshot — a
measurement. Two Ink defects (below) produce output that looks plausible in a
diff and shears the frame on screen.

```sh
npm run build
( sleep 3; printf '\003' ) | script -q /dev/null \
  sh -c "stty cols 118 rows 44; TERM=xterm-256color FORCE_COLOR=3 ./dist/cli.js"
```

Then take the last frame (everything after the final `ESC[G`), strip ANSI, and
assert two things: **every non-empty line is exactly the terminal width**
(`string-width`, not `.length`), and **the stream contains zero `ESC[2J`**. A
clear-screen is Ink giving up on incremental repaint; on screen it is flicker.

## Ink 5, three defects worked around

1. **A double-width character overflows by one cell.** Ink measures an emoji or
   CJK char at 2 (same `string-width` we use) and writes it one cell too wide.
   The row runs past the frame, the terminal wraps it, and every row below is
   sheared. One `⚽` in a three-week-old tool result was enough.
   → `sanitizeWidth()` in `src/utils/format.ts` replaces every width-2
   character with `·` and drops zero-width ones. It is called from `truncate()`
   and `fit()`, so **all display text must go through `Line`, `truncate` or
   `fit`** — never a bare `<Text>{someString}</Text>` with untrusted content.
2. **Ink clear-screens when output height *reaches* the row count** — reaching
   it, not exceeding it. Every view is therefore built to `rows - 1`. The
   budgets are, per view: the dashboard's `M`/`K` split in `Dashboard.tsx`
   (`bottomPanelHeight()` and `H - 9 - K`), `panelH = height - 8` in
   `src/app.tsx` for the two deep views, then `transcriptCapacity()` in
   `SessionDetail.tsx` and `projectViewFixedRows()` in `ProjectView.tsx` for
   what fits inside them. Add a row to any view and you must pay for it in the
   matching budget.
3. **`overflow="hidden"` corrupts rows adjacent to a blank row** when content
   is taller than the box: the first character of the neighbour is lost and the
   blank disappears (`ctive Project`, `ath`). → Panels slice their own rows to
   the available height (see `ActiveProject` in `Dashboard.tsx`) and render
   blanks as full-width `Line`s. Do not rely on Ink clipping for windowing.

Glyphs: `▶` (U+25B6) has emoji presentation and measures 2 columns. The fold
glyphs are `▸`/`▾`. Check any new glyph with `string-width` before shipping it.

## The `~/.claude` format is undocumented and moves

`docs/data-source.md` is the reverse-engineered spec; 12 distinct `version`
strings appear in one store. Re-read it before touching a parser. The four
things that break naive code:

- **Never decode a project directory name.** The encoding maps both `/` and `.`
  to `-`, so it is lossy and ambiguous. `resolveProjectPath()` re-encodes each
  observed `cwd` and keeps the one that matches exactly. A session's `cwd`
  moves around — one directory here held ten distinct values.
- **Over a third of record types carry no `timestamp`,** and a metadata record
  is frequently the physical last line. Take the last record that *has* one, and
  cross-check the file's mtime.
- **`is_error: null` is not a failure** (561 of 1047 observed results). Only
  `true` counts — and a *declined permission prompt* is also `true` while not
  being a failure at all; `isUserRejection()` excludes it.
- **`TodoWrite` does not exist in 2.1.x.** The plan is `TaskCreate` /
  `TaskUpdate`, and `taskId` is the 1-indexed creation ordinal.

Sessions are `.jsonl` files **directly inside** a project directory. Discovery
never recurses: `<session-id>/subagents/*.jsonl` are subagent transcripts, and a
directory holding only `memory/` is not a project.

## `claude -p` writes a session in its cwd

This is the trap that keeps costing. Any process that shells out to `claude`
creates a project directory in the store *Control Tower reads*. Left unhandled
it has twice produced phantom projects — once 8, once 26, taking the tool from
7 projects to 33.

**Every path that invokes `claude` must run in `summaryRunnerDir()`**
(`~/.cache/control-tower/runner`), which discovery skips. That includes scripts
under `plugin/`, which cannot import the TypeScript and must recompute the same
path — `plugin/skills/project-next-steps/scripts/check-contract.mjs` does.

Discovery matches that directory by the **suffix** `RUNNER_DIR_SUFFIX`
(`-control-tower-runner`), not by the full encoded path, so a runner made under
a different `XDG_CACHE_HOME` is skipped too.

Also: `stdio: ['ignore', ...]` is a **no-op under `execFile`** — the child still
gets a live stdin and waits on it. `child.stdin?.end()` is what stops the wait.

## Boundaries the tool advertises

Read-only by design: it never resumes, kills, or writes to a session. Three
deliberate exceptions, and each is documented in `README.md` because the promise
is load-bearing:

| What | Where | Opt-out |
|---|---|---|
| `git status` in each project directory | `src/data/git.ts` | `--no-git` |
| **Key NAMES** from `.env.example` and `.env` | `src/data/usertasks.ts` | `--no-user-tasks` |
| `gh secret list` on the project's repository | same | off unless `--secrets` |
| A network call to the Claude API | `src/data/summarize.ts` | off unless `--ai` |
| A cache write under `$XDG_CACHE_HOME/control-tower` | same | same |

Nothing is ever written inside `~/.claude`. If you add another exception, update
the README table in the same commit.

**Reading `.env` carries a rule with it: names leave, values never do.** A `.env`
holds live credentials. `parseAssignments()` returns the left-hand side of each
assignment and lets the value fall out of scope; the only fact derived from a
value is whether it was empty or an obvious placeholder. No value may reach a
`UserTask`, the screen, the cache, or the API — `tests/usertasks.test.ts` plants
a sentinel secret and asserts it appears in none of them. Keep that test passing
or drop the feature.

## The plugin

`plugin/` ships two skills and an agent, loaded with `--plugin-dir`
(`pluginDir()` resolves it from the module's own location, since the runner runs
outside every project). Without the flag, `claude` answers
`Unknown command: /project-next-steps` — and `parseSteps()` now throws on that
sentence rather than caching it as a next step.

**The envelope format is pinned in two places** — `buildEnvelope()` in
`src/data/summarize.ts` and the "Input envelope" section of
`plugin/skills/project-next-steps/SKILL.md`. Change them in the same commit.
The tail is truncated *inside* the delimiters; slicing the whole envelope eats
the opening one.

Each skill carries its own checker, because a contract in prose is not a
contract: `check-contract.mjs` (output) and `check-format.mjs` (input). Run them
after editing a SKILL.md.

Skill prompts are written to survive **haiku**, which is what the runner uses.
Test prompt edits on haiku, never on a larger model — preamble and stray
markdown are haiku's failure modes, not Opus's.

## Statuses and actions are deductions

Nothing on disk says "this session is running". `docs/status-heuristics.md`
lists the rules *and their named failure modes* — a session blocked on a
permission prompt is indistinguishable from one working, a long `Bash` looks
idle, and `done` means "at rest", never "succeeded". Keep that honesty in any
copy you write; the tool's credibility rests on not overclaiming.

## Checks

```sh
npm run typecheck && npm run lint && npm test && npm run build
```

121 tests, under a second. CI runs the same four plus two smoke steps.
