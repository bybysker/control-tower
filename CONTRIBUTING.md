# Contributing

Thanks for looking. Control Tower is small on purpose; the bar for a change is
that it keeps being small and keeps being honest about what it knows.

## Before you start

Read [CLAUDE.md](CLAUDE.md). It is short and it is the list of things that
will bite you — three Ink rendering defects, four parsing traps in the
undocumented `~/.claude` format, and the one that keeps costing: `claude -p`
writes a session into its current directory.

## The loop

```sh
npm install
npm run typecheck && npm run lint && npm test && npm run build
```

`dist/cli.js` is committed on purpose: a global install from a git URL cannot
build (no devDependencies there), so the built file ships in git and CI refuses
a commit whose `dist/` differs from a fresh build. **Rebuild and commit `dist/`
with any change to `src/`.**

Tests run in under a second. CI runs the same four steps plus two smoke runs.

**A UI change is not done until it has been measured under a pty** — every row
exactly the terminal width, zero clear-screens. The procedure is the first
section of `CLAUDE.md`. A screenshot is not a measurement.

## What a good change looks like

- **Deductions stay labelled as deductions.** Nothing on disk says a session is
  running; `docs/status-heuristics.md` lists each rule with its failure modes.
  Do not write copy that overclaims.
- **Reads outside `~/.claude` are exceptions, each with an opt-out**, listed in
  a table in `CLAUDE.md` and mirrored in the README. Add a row in the same
  commit if you add one.
- **Names leave, values never do.** Anything that opens a `.env` returns key
  names only. `tests/usertasks.test.ts` plants a sentinel secret; keep it passing.
- **Anything that shells out to `claude` runs in `summaryRunnerDir()`**, which
  discovery skips. Otherwise every run becomes a phantom project.
- Skill prompts under `plugin/` are written to survive **haiku**. Test prompt
  edits on haiku, and run the skill's checker script afterwards.

## Reporting a bug

Say what `control-tower --once` printed, what you expected, and — if it is a
rendering bug — your terminal size. If it is a parsing bug, the Claude Code
version (`claude --version`) matters: the format moves between releases.

## Cutting a release

```sh
npm version patch          # bumps package.json, commits, tags vX.Y.Z
npm run build && git add dist && git commit --amend --no-edit
git push && git push --tags
npm pack && gh release create vX.Y.Z control-tower-X.Y.Z.tgz --title vX.Y.Z --generate-notes
```

The README's install line points at the release tarball, so update the version
there too. `npm install -g github:…` is deliberately not offered: broken on
npm 10.8, see the README.
