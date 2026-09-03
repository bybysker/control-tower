# Claude Code local session storage

Reverse-engineered on **2026-09-01** from a real machine running Claude Code
`2.1.197` (records in the store span `2.1.170` → `2.1.247`). Everything below was
observed directly; nothing is taken from documentation, because none is published.

There is **no CLI and no index file** that enumerates sessions.
`claude sessions list` is not a subcommand — it is parsed as a *prompt* and
starts a normal Claude session that answers in prose. `claude --help` confirms
the only session-related flags are `--resume` / `--continue`. So parsing the
on-disk JSONL is the only machine-readable route.

## Layout

```
~/.claude/
├── projects/
│   └── <encoded-cwd>/                       # e.g. -home-alice-code-bootcamp-rag-eval-v2-1
│       ├── <session-uuid>.jsonl             # ONE SESSION = ONE FILE
│       ├── <session-uuid>/                  # optional sidecar dir, NOT a session
│       │   ├── subagents/agent-*.jsonl      # subagent transcripts + .meta.json
│       │   └── tool-results/                # spilled large tool outputs
│       └── memory/                          # auto-memory markdown, NOT a session
├── sessions/        # <pid>.json + .key — IPC/auth handles, not transcripts
├── session-env/     # <session-uuid>/ per-session env, no transcript
├── history.jsonl    # global prompt history, not per-session
└── settings.json    # user settings, no session index
```

### Project directory name is lossy — do not decode it

`<encoded-cwd>` is the absolute cwd with `/` **and** `.` both replaced by `-`.
That makes it ambiguous: `-home-alice-code-bootcamp-rag-eval-v2-1` is really
`/home/alice/code/bootcamp/rag-eval-v2.1`, and no decoder can recover which
`-` was a dot.

**We never decode it.** The directory name is used only as the *grouping key*
(stable, matches the filesystem). The human-readable path comes from the `cwd`
field carried on real records inside the file. `cwd` can change mid-session, so
we take it from the **last record that has one**.

### What is not a session

- `memory/` — a directory, no `.jsonl` at its top level.
- `<session-uuid>/subagents/agent-*.jsonl` — subagent transcripts. A naive
  `**/*.jsonl` glob picks these up and inflates the session count with phantom
  rows. We only read `.jsonl` files **directly inside** a project directory.
- A project directory with zero `.jsonl` (observed: `-home-alice-code-archive`,
  which holds only `memory/`) — must not render as an empty group.

## Record shapes

Every line is one JSON object with a `type`. Observed distribution over 13
sessions / ~5000 records:

| type | count | has `timestamp` | notes |
|---|---:|:---:|---|
| `assistant` | 2103 | yes | `.message` is a full Anthropic API message |
| `user` | 1139 | yes | prompt, or a `tool_result` carrier |
| `attachment` | 688 | yes | injected context (deferred tools, files) |
| `last-prompt` | 280 | **no** | `{lastPrompt, leafUuid}` |
| `ai-title` | 263 | **no** | `{aiTitle}` — generated title |
| `mode` | 122 | **no** | `{mode}` |
| `custom-title` | 95 | **no** | `{customTitle}` — user-set title |
| `queue-operation` | 94 | yes | `{operation, content}` queued prompt |
| `atis-latch` | 92 | **no** | internal |
| `system` | 74 | yes | hook summaries, `subtype` |
| `bridge-session` | 71 | **no** | desktop bridge handle |
| `permission-mode` | 50 | **no** | `{permissionMode}` |
| `file-history-snapshot` | 34 | **no** | edit snapshots |
| `frame-link`, `pr-link`, `file-history-delta`, `artifact-*` | <20 | mixed | ignored |

### The timestamp trap

**More than a third of record types carry no `timestamp`,** and a metadata
record is frequently the physical last line of the file — in the session sampled,
the final line was a `bridge-session` with no timestamp at all. Taking "the
timestamp of the last line" therefore yields `undefined` and collapses every
status derivation.

We take the timestamp of the **last record that has one**, and cross-check it
against the file's `mtime`, using the later of the two.

### Common envelope (on `assistant` / `user` / `system` / `attachment`)

```jsonc
{
  "uuid": "…", "parentUuid": "…",         // linked list of turns
  "sessionId": "…",                        // matches the filename
  "timestamp": "2026-09-01T18:19:51.405Z", // ISO-8601 UTC
  "cwd": "/home/alice/code",         // true path, un-encoded
  "gitBranch": "main",
  "version": "2.1.197",
  "entrypoint": "claude-desktop" | "cli",
  "isSidechain": false,
  "userType": "external"
}
```

`isSidechain` was `false` on every record in every main transcript, so filtering
on it is a no-op in practice. We filter anyway (cheap), but it is the
`subagents/` directory exclusion that actually keeps subagents out.

### `assistant`

`.message` = `{id, role, model, content[], stop_reason, stop_sequence, usage}`.
`content[]` blocks are `text` | `thinking` | `tool_use`.

`stop_reason` distribution: `tool_use` 1989, `end_turn` 121, `stop_sequence` 3.
This is the backbone of status derivation — a transcript ending on `tool_use`
was cut off mid-work; one ending on `end_turn` finished a turn cleanly.

### `user`

`.message.content` is **either a plain string** (a typed prompt) **or an array**
of blocks — `text`, or `tool_result` `{tool_use_id, content, is_error}`.
A `toolUseResult` sibling field carries the richer/raw result object.

`is_error` distribution: `null` 561, `false` 460, `true` 26. **`null` is not a
failure** — only `is_error === true` counts.

## Titles

Three sources, each appearing repeatedly through a file (a new one is appended
whenever it is regenerated), so we take the **last** occurrence of each:

1. `custom-title` → `.customTitle` — user-set, wins.
2. `ai-title` → `.aiTitle` — generated.
3. `last-prompt` → `.lastPrompt` — truncated first prompt.
4. Fallback: the first 8 chars of the session UUID.

## The current plan: `TaskCreate` / `TaskUpdate`, not `TodoWrite`

**There is no `TodoWrite` record anywhere in this store** — zero occurrences of
the tool name, and zero occurrences of the string `"todos"` across all 13
sessions. Claude Code 2.1.x tracks the plan with a different pair of tools:

```jsonc
// tool_use, name: "TaskCreate"
{ "subject": "Scaffold teaching-repo (imiter) main",
  "description": "Build the imiter-style repo…",
  "activeForm": "Scaffolding teaching-repo main" }

// tool_use, name: "TaskUpdate"
{ "taskId": "1", "status": "in_progress" }   // then later "completed"
```

The `tool_result` for a `TaskCreate` reads `Task #1 created successfully: …`, so
**`taskId` is the 1-indexed creation ordinal within the session.** We derive the
id from creation order rather than parsing that sentence, because the sentence is
a UI string that will drift while the ordinal will not.

Verified session-scoped and monotonic: in the busiest session all 7 `TaskCreate`
calls were emitted as one upfront batch numbered 1→7, and the 14 subsequent
`TaskUpdate` calls walked them `in_progress`→`completed` in order. No restart at
`#1` was ever observed, so tasks accumulate for the whole session and "the
current plan" is simply every task created, carrying its latest status.

`plan.ts` implements **both** extractors: `TaskCreate`/`TaskUpdate` (primary,
what this machine actually emits) and `TodoWrite` → `input.todos` (fallback, for
older versions and other machines). Whichever yields tasks is rendered.

## Supervision signals

Three more things the transcripts carry, all used by the project view.

### `AskUserQuestion` — a question the human owes

```jsonc
// tool_use, name: "AskUserQuestion"
{ "questions": [ { "question": "Je pousse ?", "header": "Push",
                   "options": [ { "label": "Pousser" }, { "label": "Ne pas pousser" } ] } ] }
```

Its `tool_result` carries the chosen answer. **A call with no result is the
strongest "needs you" signal there is**: Claude stopped and asked. The first
question is surfaced with its options verbatim; the tool accepts up to four but
every call observed carried one.

### `pr-link` — a pull request the session opened or referenced

```jsonc
{ "type": "pr-link", "prNumber": 44, "prUrl": "https://github.com/…/pull/44",
  "prRepository": "octocat/atlas-api", "timestamp": "…" }
```

Appended repeatedly (nine times for one PR in one session), so links are
deduplicated by URL at the project level.

### `memory/MEMORY.md` — the project's own notes

Claude Code's auto-memory index for the project. Not a session, but the best
"what do I know about this project" text on disk. Its `- [Title](file) — hook`
bullets are shown as plain lines in the project view.

## Tool usage observed

`Bash` 482, `Write` 286, `Edit` 125, `Read` 76, `TaskUpdate` 21, `Agent` 19,
`TaskCreate` 12, `Skill` 6, `ToolSearch` 5, plus a tail of MCP tools.

## Stability

This format is undocumented and version-dependent — 12 distinct `version`
strings appear in this store alone. Every record is validated with a permissive
Zod schema: unknown `type`s are skipped, and a record that fails validation is
dropped rather than crashing the parse. A malformed line (truncated final line
of a file being actively written) is also skipped.
