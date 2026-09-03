# Status heuristics

**These are deductions, not facts.** Claude Code does not write a status field.
Nothing on disk says "this session is running". Every status below is inferred
from the shape and recency of the transcript tail, and each rule can be wrong in
ways listed under *Known failure modes*.

A session that ended cleanly and a session whose process was killed can look
identical on disk. We cannot tell them apart, and we do not pretend to.

## The five statuses

Evaluated in order; first match wins.

| Status | Glyph | Colour | Rule |
|---|:---:|---|---|
| `running` | `●` | yellow | Last activity < **10s** ago **and** the transcript ends mid-work |
| `failed`  | `✗` | red    | The last `tool_result` has `is_error === true` |
| `done`    | `✓` | green  | Last `assistant` record has `stop_reason: "end_turn"` |
| `stalled` | `…` | magenta| No activity for > **30 min** |
| `idle`    | `○` | gray   | Anything else |

### "Ends mid-work"

`running` needs a real signal, not just recency — a user who typed a prompt 3
seconds ago and a session actively burning through tools both look recent.
The load-bearing clause is the second one. A transcript "ends mid-work" when
either:

- the last `assistant` record has `stop_reason: "tool_use"` and at least one of
  its `tool_use` blocks has **no matching `tool_result`** later in the file
  (Claude asked for a tool and the answer never arrived — it is still running), or
- the last substantive record is a `user` prompt with no `assistant` reply after
  it (Claude has been asked something and has not answered yet).

The `stop_reason` split makes this discriminating: across this machine's store,
1989 records stop on `tool_use` versus 121 on `end_turn`.

### `failed`

Only `is_error === true` counts. `is_error` is `null` on 561 of 1047 observed
`tool_result` blocks — **`null` is not a failure**, it is a field that was simply
not written. Treating `null` as an error would mark most sessions failed.

We deliberately do **not** grep transcript text for the words "error" or
"failed". A session that discusses an error is not a failed session, and this
tool exists to watch sessions that spend most of their time discussing errors.
The `is_error` flag is the only failure signal we trust.

### `done`

`stop_reason: "end_turn"` means Claude finished a turn without asking for a
tool. It does **not** mean the task succeeded, or that the user will not type
again — it means the transcript is at a natural resting point. A `done` session
becomes `running` again the moment the user sends another prompt.

## Thresholds

| Constant | Value | Why |
|---|---:|---|
| `RUNNING_WINDOW_MS` | 10 000 | A working session writes records every few seconds; 10s covers a slow tool call without going stale. |
| `STALLED_AFTER_MS` | 1 800 000 (30 min) | Long enough that a coffee break does not trip it. |

Both are exported from `src/data/status.ts` and are the only tuning knobs.

## Timestamp source

Derived from the **last record that carries a `timestamp`** — over a third of
record types have none, and a metadata record is frequently the physical last
line of a file. Cross-checked against the file's `mtime`; the later of the two
wins, so a burst of untimestamped metadata does not make a live session look
stale.

## Actions: reading the failure modes from the other side

Two of the failure modes below are not noise from the project's point of view —
they are the moments where **nothing moves until the human does something**.
`actions.ts` names them, highest certainty first:

| Kind | Signal | Certainty |
|---|---|---|
| `answer` | An `AskUserQuestion` with no `tool_result`. Question and options shown verbatim. | Certain: Claude stopped and asked. |
| `failed` | Session status is `failed` (see above). The error text is quoted. | High. |
| `permission` | A tool call still unanswered past `RUNNING_WINDOW_MS`, and the user did **not** decline it. | Probable: usually a permission prompt, sometimes a dead process. The label says both. |
| `reply` | Claude's last words end in `?` and nothing is pending. | Moderate: rhetorical questions exist. |

A declined permission prompt is **not** an action: the human already answered.
An action older than seven days drops off the card — still true, no longer for
today.

At the project level, any action outranks every session status: the project
reads `action` before `failed`, `running`, `idle`, `done`, `stalled`, and sorts
first.

## Next steps: three sources, ranked by what they know

| Source | Signal | Certainty |
|---|---|---|
| `plan` | `TaskCreate` / `TaskUpdate` tasks still `in_progress` or `pending`. | Highest: Claude stated the intent. Present in 2 sessions out of 18 here. |
| `git` | Uncommitted files, unpushed commits, a branch with no upstream, a clean branch still off trunk, incoming commits. | Certain as fact, mechanical as meaning: it knows what is left hanging, not why. |
| `ai` | Claude summarising the session tail, behind `--ai`. | A guess. Non-deterministic, marked `∴`, never automatic. |

Git steps are ordered by proximity to losing work — commit, push, land, pull —
and untracked files surface only when nothing else is outstanding.

**Prose is not a source.** Next steps appear in transcripts under headings like
"## Prochaines étapes" and "**Ce qui reste**", but in 4 sessions out of 18, in
two languages, mixed with false friends such as "## Ce que j'ai trouvé". The
yield does not justify presenting the noise as a to-do list.

## Known failure modes

1. **A killed process looks `idle` or `done`, never `failed`.** No exit code is
   written to the transcript. If Claude Code crashes mid-tool, the session shows
   `running` for 10s and then falls to `idle`, and after 30 min to `stalled`.
2. **A session waiting on a permission prompt looks `running`.** It ends on an
   unanswered `tool_use`, which is exactly our `running` signal. It is blocked on
   the human, not working — we cannot distinguish the two from disk.
3. **A long tool call looks `idle`.** A 5-minute `Bash` command writes nothing
   for 5 minutes; the session drops out of `running` at the 10s mark even though
   it genuinely is running. This is the main source of false `idle`.
4. **`done` is not success.** See above.
5. **A git step is not a judgement.** "Commit or stash 9 changed files" is true
   of a repository someone is mid-thought in, and of one abandoned a month ago.
   The tool reports the state; only you know which it is.
6. **Clock skew.** Timestamps are UTC from the writing machine. Reading a store
   copied from another host with a skewed clock will produce nonsense ages.

## What live data could and could not verify

On the machine this was built against, only one session was recent enough to
exercise `running`; the rest were hours to days old and landed on `stalled`.
The `done`, `failed`, and `idle` paths are therefore covered by fixtures in
`tests/status.test.ts` rather than by observation.
