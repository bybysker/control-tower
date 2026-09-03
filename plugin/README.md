# Control Tower plugin

Skills and agents that operate the supervision workflow. Versioned here so
they can be edited without rebuilding the binary, and loaded from anywhere:

```sh
claude --plugin-dir "$(npm root -g)/control-tower/plugin"   # or <your clone>/plugin
```

Control Tower's `--ai` runner passes that flag itself, which is why the skill
works even though the runner deliberately executes outside any project (see
`summaryRunnerDir()` — `claude -p` writes a session in its cwd, so summarising
a project must not happen inside it).

| Artifact | Kind | Invoked |
|---|---|---|
| `project-next-steps` | skill | by the `--ai` runner, or `/project-next-steps` |
| `project-handoff` | skill | by Control Tower's handoff key, or `/project-handoff` |
| `triage` | agent | by you, in any session |
