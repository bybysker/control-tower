# Contract tests

Four cases. Any edit to `SKILL.md` has to survive all four, on **haiku**, before
it is committed — the whole point of moving the prompt out of
`src/data/summarize.ts` is that it can now be edited without a rebuild, which
also means it can now be broken without a failing unit test.

```sh
node plugin/skills/project-next-steps/scripts/check-contract.mjs
node plugin/skills/project-next-steps/scripts/check-contract.mjs rag-eval
```

Four `claude -p` calls on haiku, roughly two minutes, exit 1 on any violation.
Envelopes live in `fixtures/`; the script runs the real invocation (same flags,
same one turn) and pipes stdout through a copy of `parseSteps()`.

> `parseSteps()` is duplicated inside the script rather than imported: the skill
> is loadable from anywhere via `--plugin-dir`, so it cannot assume the
> TypeScript is built, or even present. If `src/data/summarize.ts` changes its
> parsing, change the copy at the top of `check-contract.mjs` too.

## Why these four

Each one is the case that breaks a different clause of the contract.

| Fixture | Breaks what, if anything is wrong | Must produce |
|---|---|---|
| `chat-bot` | **the ban list.** Dirty tree, feature branch, 1 unpushed commit, PR open — everything invites "commit and push". If a git chore appears here, the ban list is too soft. | 1–3 steps, none of them git |
| `demo-app` | **`NONE`.** Clean trunk, month-old session that only read a README. A chatty model writes "Review the deployment workflow" to look useful. | exactly `NONE`, parsed as zero steps |
| `teaching-repo` | **the teaching-repo rule.** The tail says the reference is on a local-only `instructor` branch and that `main` was just checked for hints. Suggesting to push, merge, or document any of it does real damage. | steps about the stack only; nothing naming `instructor`, briefs, hints, or solutions |
| `rag-eval` | **archetype vocabulary.** An LLM app whose eval is stale after a re-chunk. A generic answer says "test the changes"; the right answer names `make eval` and `make seed-kb`. | steps using the repo's own make targets |

## Recorded passes

Measured on 2026-09-02, `claude -p --plugin-dir … --model haiku --max-turns 1`.
One run out of five, all green; wording differed every time. Not golden output
— the model is non-deterministic and this source is a guess by construction.
They are here so a regression is recognisable as one.

```
chat-bot        Register the webhook handler in the FastAPI app factory     (55)

demo-app        NONE

rag-eval        Run make seed-kb to reseed the knowledge base               (45)
                Run make eval to evaluate the updated prompts               (45)
                Compare the eval delta from the changes                     (39)

teaching-repo   Fix the column mismatch in db.py breaking make seed         (51)
```

Runtimes were 12–18 s per call on that run.

Two of the four returned a single step and one returned nothing at all. That
is the contract working: `chat-bot`'s tail names exactly one thing left to do,
and a model that padded it to three would have been inventing two. The
fixtures are synthetic — written to preserve what each case tests, with no real
session content — so the outputs above are what the skill does on shapes, not
on anyone's project.

## What the checker asserts

- ≤ 3 steps, after `parseSteps()`.
- Each step < 70 characters. Nothing in the TypeScript truncates.
- No git chore, in any of the wordings `gitSteps()` renders: `commit`, `stash`,
  `push`, `pull`, `fetch`, `rebase`, `merge`, `land`, `ship`, `publish`,
  `upstream`, `untracked`, `git add`, and PR *creation* (`open / create / raise
  / submit a PR`). `land` and `publish` matter as much as `push`: they are the
  literal verbs in `Land <branch> — clean and pushed, still off trunk` and
  `Publish branch <name> — it has no upstream`, and a model that has been told
  not to say "push" reaches for them next.
- A bare `PR` and a bare `review` are deliberately **not** banned. Addressing
  review comments on an open PR is real work that `git status` cannot derive;
  only creating the PR is the banned "land" step in disguise.
- No preamble surviving as a step (`Here are…`, `Based on…`, `Let me…`).
- No markdown: fences, headings, `**bold**`, tables, block quotes — and no
  inline backticks. The parser strips a leading bullet or `1.` and nothing
  else, so a fence ships as a step; and the Next-steps panel is plain text, so
  a step written as ``Run `make eval` `` renders with its backticks showing.
- Per-fixture rules from the table above.

## Adding a fixture

Drop `<name>.txt` in `fixtures/` using the envelope shape from `SKILL.md`, and
add a `<name>` entry to `EXTRA` in `check-contract.mjs` if the case has a rule
of its own. A fixture with no `EXTRA` entry is still checked against the
generic contract.

Real tails are better than invented ones. To lift one from a live project:

```sh
control-tower --once            # find the project's newest session
```

then take the last dozen `[assistant]` / `[user]` lines, as `sessionTail()`
builds them. Scrub anything private before committing it — fixtures live in git
and this repository is meant to be shareable.

## Failure modes this suite does not cover

- **Prompt injection.** No fixture contains a tail that tries to override the
  output format. `SKILL.md` says the tail is data, but nothing here proves the
  model obeys under attack.
- **A hostile teaching-repo tail.** `teaching-repo`'s fixture is *cooperative*: it
  says the reference is already on `instructor` and that `main` was already
  checked for hints, so the model is never tempted. The tail that would really
  exercise the teaching-repo rule is the opposite one — a session that just wrote
  `INSTRUCTOR_NOTES.md` onto `main`, or one saying *"il faut que j'aligne
  instructor avec main"*. Until such a fixture exists, **the teaching-repo guard is
  written but untested**; treat it as prose, not as a verified behaviour.
- **A tail in a language other than French or English.** Both fixtures'
  languages are the ones on this machine.
- **A very long single-file refactor**, where the tail is 4 000 characters of
  one diff and the useful signal was truncated away.
- **Non-git projects.** `GIT: not-a-repo` and the `--no-git` case (no `GIT:`
  line at all) are documented in `SKILL.md` and untested.
