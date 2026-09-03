/**
 * Domain types for Control Tower.
 *
 * The on-disk shapes these are derived from are documented in
 * docs/data-source.md. Everything here is *our* model, deliberately narrower
 * than what Claude Code writes.
 */

export type Status = 'running' | 'idle' | 'done' | 'failed' | 'stalled';

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

/** One entry of a session's current plan. */
export interface Task {
  /** 1-indexed creation ordinal within the session — the id TaskUpdate refers to. */
  id: string;
  subject: string;
  description?: string;
  /** Present-tense label ("Scaffolding the repo"), when the source provided one. */
  activeForm?: string;
  status: TaskStatus;
}

/** Where a plan was extracted from. Sessions differ by Claude Code version. */
export type PlanSource = 'task-tools' | 'todo-write' | 'none';

export interface Plan {
  source: PlanSource;
  tasks: Task[];
}

/** A normalised transcript entry — what the detail view renders. */
export type TurnRole = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';

export interface Turn {
  role: TurnRole;
  /** Human-readable one-liner. Never contains newlines. */
  text: string;
  timestamp?: Date;
  /** Tool name, for tool_use / tool_result turns. */
  toolName?: string;
  /** True only when a tool_result carried is_error === true. */
  isError?: boolean;
}

/**
 * Everything parse.ts extracts from a single .jsonl file. Kept flat and
 * serialisable so it can be cached per session id.
 */
export interface ParsedSession {
  sessionId: string;
  /** Last cwd seen on a record that carried one; undefined if the file had none. */
  cwd?: string;
  /** Every distinct cwd observed, in first-seen order. Candidates for the
   *  project's true path -- cwd moves around within a single session. */
  cwds: string[];
  gitBranch?: string;
  /** Claude Code version that wrote the most recent record. */
  version?: string;
  entrypoint?: string;
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  /** First timestamp seen, i.e. when the session started. */
  firstTimestamp?: Date;
  /** Last record that *carried* a timestamp. Metadata records have none. */
  lastTimestamp?: Date;
  /** Count of user + assistant records. What the UI calls "turns". */
  turnCount: number;
  /** Normalised tail for the detail view. Bounded by TRANSCRIPT_TAIL_LIMIT. */
  turns: Turn[];
  plan: Plan;
  /** stop_reason of the final assistant record. */
  lastStopReason?: string;
  /** True when the transcript ends on work that never completed. See status.ts. */
  endsMidWork: boolean;
  /** True when the final tool_result carried is_error === true. */
  lastToolErrored: boolean;
  /** True when that final error was the user declining a tool call, rather
   *  than the tool actually failing. See docs/status-heuristics.md. */
  lastToolRejectedByUser: boolean;
  /** Last assistant prose, flattened. What "where we are" is built from. */
  lastAssistantText?: string;
  /** Name of the final assistant record's tool call that never got a result. */
  pendingToolName?: string;
  /** Set when that unanswered call is an AskUserQuestion: the human owes an answer. */
  pendingQuestion?: PendingQuestion;
  /** Pull requests linked from this session, in file order. */
  prLinks: PrLink[];
  /** Lines that failed to parse or validate. Surfaced, never thrown. */
  malformedLines: number;
}

export interface Session extends ParsedSession {
  /** Absolute path of the .jsonl file. */
  filePath: string;
  /** The encoded project directory name — the grouping key. */
  projectDir: string;
  /** File mtime, cross-checked against lastTimestamp. */
  mtime: Date;
  /** max(lastTimestamp, mtime) — what status and "time ago" are computed from. */
  lastActivity: Date;
  status: Status;
  /** Display title, resolved by precedence: custom > ai > lastPrompt > id prefix. */
  title: string;
  /** Last assistant text, truncated for the root-view snippet column. */
  snippet: string;
}

/**
 * Something the human has to do before a project moves again. Ranked by how
 * clearly the transcript says so: an unanswered AskUserQuestion is certain, a
 * tool call waiting past the running window is probably a permission prompt.
 */
export type ActionKind = 'answer' | 'permission' | 'failed' | 'reply';

export interface UserAction {
  kind: ActionKind;
  /** One imperative line for the card. */
  label: string;
  /** Choices offered, when the action is a question with options. */
  options?: string[];
  sessionId: string;
  sessionTitle: string;
  since: Date;
}

/** Where a next step was derived from. Shown, because certainty differs. */
export type NextStepSource = 'plan' | 'git' | 'ai';

export interface NextStep {
  source: NextStepSource;
  /** Stable key for React and for ordering within a source. */
  id: string;
  /** Imperative one-liner: what to actually do. */
  label: string;
  /** Only for plan steps -- keeps the ✓/●/○ glyph meaningful. */
  status?: TaskStatus;
}

/**
 * Where a user task was found. `env` and `ci` are facts on disk; `ai` is the
 * opt-in enrichment that says which console to open.
 */
export type UserTaskSource = 'env' | 'ci' | 'ai';

/**
 * Something only a human can do: open a console, hold a credit card, accept
 * terms, click an OAuth consent. Distinct from `UserAction`, which is a
 * session that stopped and is waiting on an answer.
 */
export interface UserTask {
  source: UserTaskSource;
  id: string;
  /** The thing to do, imperative. */
  label: string;
  /** The name of the secret or variable, never its value. */
  key?: string;
  /** Where to go, when known: a console name or URL. Filled by `ai`. */
  where?: string;
  /** True when nothing in the project can run until this is done. */
  blocking: boolean;
  /** True when this is work, but not the human's: hand it to an agent. */
  delegable?: boolean;
}

/** Project-level status: the most attention-worthy thing about it. */
export type ProjectStatus = 'action' | Status;

export interface ProjectSupervision {
  status: ProjectStatus;
  actions: UserAction[];
  /** Last thing Claude said in the most recent session -- "where we are". */
  whereWeAre?: { text: string; sessionId: string; at: Date };
  /** Plan tasks first, then what the repository state implies, then AI. */
  nextSteps: NextStep[];
  /** What only the human can do: keys, consoles, billing, consents. */
  userTasks: UserTask[];
  /** Deduplicated by URL, most recent first. */
  prLinks: PrLink[];
  git?: GitState;
  /** Index lines of the project's memory/MEMORY.md, when it has one. */
  memory: string[];
}

export interface GitState {
  branch?: string;
  dirty: boolean;
  /** Tracked files modified, staged, or unmerged. */
  changed: number;
  untracked: number;
  ahead?: number;
  behind?: number;
  notARepo: boolean;
}

export interface Project {
  /** Encoded directory name — stable, unique, the grouping key. */
  dir: string;
  /** Human path from session cwd, or the raw dir name when nothing better exists. */
  path: string;
  /** Short label for the root view, e.g. "bootcamp" or "DevProjects (root)". */
  label: string;
  sessions: Session[];
  /** Most recent lastActivity across sessions — projects sort by this. */
  lastActivity: Date;
  supervision: ProjectSupervision;
}

/** A question Claude put to the human via AskUserQuestion and is still waiting on. */
export interface PendingQuestion {
  question: string;
  header?: string;
  options: string[];
}

/** A pull request a session linked (from `pr-link` records). */
export interface PrLink {
  number: number;
  url: string;
  repository?: string;
  timestamp?: Date;
}

/** Bounded so a 2.8 MB transcript does not put 5000 turns in memory per session. */
export const TRANSCRIPT_TAIL_LIMIT = 200;
