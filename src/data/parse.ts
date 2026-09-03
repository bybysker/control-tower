import { z } from 'zod';
import type { ParsedSession, PendingQuestion, Plan, PrLink, Task, TaskStatus, Turn } from './types.js';
import { TRANSCRIPT_TAIL_LIMIT } from './types.js';

/**
 * JSONL parsing for Claude Code transcripts.
 *
 * The format is undocumented and version-dependent (12 distinct `version`
 * strings in the store this was built against), so every schema here is
 * PERMISSIVE: unknown record types are skipped, unknown fields are ignored, and
 * a line that fails to parse is counted and dropped rather than thrown. A
 * partially-written final line is normal in a file being appended to live.
 *
 * See docs/data-source.md for the observed shapes.
 */

const isoDate = z
  .string()
  .transform((s) => new Date(s))
  .refine((d) => !Number.isNaN(d.getTime()), { message: 'invalid timestamp' });

const textBlock = z.object({ type: z.literal('text'), text: z.string() });

const thinkingBlock = z.object({ type: z.literal('thinking') });

const toolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string().optional(),
  name: z.string(),
  input: z.unknown().optional(),
});

const toolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string().optional(),
  // `content` is a string, or an array of blocks, depending on the tool.
  content: z.unknown().optional(),
  // null on 561 of 1047 observed blocks -- null is NOT a failure.
  is_error: z.boolean().nullish(),
});

const contentBlock = z.union([
  textBlock,
  thinkingBlock,
  toolUseBlock,
  toolResultBlock,
  z.object({ type: z.string() }).passthrough(),
]);

const envelope = {
  uuid: z.string().optional(),
  parentUuid: z.string().nullish(),
  sessionId: z.string().optional(),
  timestamp: isoDate.optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  version: z.string().optional(),
  entrypoint: z.string().optional(),
  isSidechain: z.boolean().optional(),
};

const assistantRecord = z.object({
  type: z.literal('assistant'),
  ...envelope,
  message: z
    .object({
      role: z.string().optional(),
      model: z.string().optional(),
      content: z.array(contentBlock).optional(),
      stop_reason: z.string().nullish(),
    })
    .passthrough(),
});

const userRecord = z.object({
  type: z.literal('user'),
  ...envelope,
  message: z
    .object({
      role: z.string().optional(),
      // Either a typed prompt (string) or an array of blocks.
      content: z.union([z.string(), z.array(contentBlock)]).optional(),
    })
    .passthrough(),
});

const systemRecord = z.object({
  type: z.literal('system'),
  ...envelope,
  subtype: z.string().optional(),
  level: z.string().optional(),
});

// Metadata records. Note: none of these carry a timestamp.
const aiTitleRecord = z.object({ type: z.literal('ai-title'), aiTitle: z.string() });
const customTitleRecord = z.object({ type: z.literal('custom-title'), customTitle: z.string() });
const lastPromptRecord = z.object({ type: z.literal('last-prompt'), lastPrompt: z.string() });
const prLinkRecord = z.object({
  type: z.literal('pr-link'),
  prNumber: z.number(),
  prUrl: z.string(),
  prRepository: z.string().optional(),
  timestamp: isoDate.optional(),
});

export type AnyRecord =
  | z.infer<typeof assistantRecord>
  | z.infer<typeof userRecord>
  | z.infer<typeof systemRecord>
  | z.infer<typeof aiTitleRecord>
  | z.infer<typeof customTitleRecord>
  | z.infer<typeof lastPromptRecord>
  | z.infer<typeof prLinkRecord>;

/** Parse one line. Returns null for blank/malformed/uninteresting lines. */
export function parseLine(line: string): AnyRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null; // truncated tail of a file being written, or corruption
  }

  if (typeof raw !== 'object' || raw === null) return null;
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== 'string') return null;

  switch (type) {
    case 'assistant': {
      const r = assistantRecord.safeParse(raw);
      return r.success ? r.data : null;
    }
    case 'user': {
      const r = userRecord.safeParse(raw);
      return r.success ? r.data : null;
    }
    case 'system': {
      const r = systemRecord.safeParse(raw);
      return r.success ? r.data : null;
    }
    case 'ai-title': {
      const r = aiTitleRecord.safeParse(raw);
      return r.success ? r.data : null;
    }
    case 'custom-title': {
      const r = customTitleRecord.safeParse(raw);
      return r.success ? r.data : null;
    }
    case 'last-prompt': {
      const r = lastPromptRecord.safeParse(raw);
      return r.success ? r.data : null;
    }
    case 'pr-link': {
      const r = prLinkRecord.safeParse(raw);
      return r.success ? r.data : null;
    }
    default:
      // attachment, mode, atis-latch, bridge-session, queue-operation,
      // permission-mode, file-history-*, frame-link, pr-link, artifact-* ...
      return null;
  }
}

function blocksOf(rec: AnyRecord): Array<z.infer<typeof contentBlock>> {
  if (rec.type !== 'assistant' && rec.type !== 'user') return [];
  const content = (rec as { message?: { content?: unknown } }).message?.content;
  if (Array.isArray(content)) return content as Array<z.infer<typeof contentBlock>>;
  return [];
}

/** Flatten a tool_result's `content` (string | block[] | object) to one line. */
function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && 'text' in b && typeof (b as { text: unknown }).text === 'string'
          ? (b as { text: string }).text
          : '',
      )
      .filter(Boolean)
      .join(' ');
  }
  if (content && typeof content === 'object') {
    const o = content as Record<string, unknown>;
    if (typeof o['stdout'] === 'string') return o['stdout'];
  }
  return '';
}

/** One-line summary of a tool_use, favouring the argument that identifies it. */
function summariseToolUse(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name;
  const o = input as Record<string, unknown>;
  if (name === 'AskUserQuestion') {
    const q = toPendingQuestion(input);
    if (q) return `${name}: ${q.question}`;
  }
  if (name === 'TaskUpdate' && o['taskId'] !== undefined) {
    return `${name}: #${String(o['taskId'])} ${typeof o['status'] === 'string' ? o['status'] : ''}`.trim();
  }
  const interesting = ['command', 'file_path', 'pattern', 'path', 'subject', 'prompt', 'url', 'query'];
  for (const key of interesting) {
    const v = o[key];
    if (typeof v === 'string' && v.length > 0) return `${name}: ${v}`;
  }
  return name;
}

/**
 * The shape AskUserQuestion is called with. Only the first question is
 * surfaced: the tool takes up to four, but every call observed carried one.
 */
const askUserQuestionInput = z.object({
  questions: z
    .array(
      z.object({
        question: z.string(),
        header: z.string().optional(),
        options: z.array(z.object({ label: z.string() })).optional(),
      }),
    )
    .min(1),
});

function toPendingQuestion(input: unknown): PendingQuestion | undefined {
  const r = askUserQuestionInput.safeParse(input);
  if (!r.success) return undefined;
  const q = r.data.questions[0];
  if (!q) return undefined;
  return { question: q.question, header: q.header, options: (q.options ?? []).map((o) => o.label) };
}

// ---------------------------------------------------------------------------
// Plan extraction
// ---------------------------------------------------------------------------

const taskStatuses: readonly string[] = ['pending', 'in_progress', 'completed'];

function coerceTaskStatus(v: unknown): TaskStatus {
  return typeof v === 'string' && taskStatuses.includes(v) ? (v as TaskStatus) : 'pending';
}

const todoWriteItem = z.object({
  content: z.string().optional(),
  activeForm: z.string().optional(),
  status: z.string().optional(),
});

/**
 * Accumulates the session's plan from tool calls, in file order.
 *
 * Primary source is TaskCreate/TaskUpdate (Claude Code 2.1.x). TaskCreate's
 * result reads "Task #N created successfully", so `taskId` is the 1-indexed
 * CREATION ORDINAL -- we derive it from creation order rather than parsing that
 * sentence, which is a UI string and will drift.
 *
 * TodoWrite (older versions, other machines) is the fallback: each call carries
 * the WHOLE list, so the last call wins outright.
 */
class PlanAccumulator {
  private tasks: Task[] = [];
  private todoWrite: Task[] | null = null;

  observe(name: string, input: unknown): void {
    if (name === 'TaskCreate') this.onTaskCreate(input);
    else if (name === 'TaskUpdate') this.onTaskUpdate(input);
    else if (name === 'TodoWrite') this.onTodoWrite(input);
  }

  private onTaskCreate(input: unknown): void {
    if (!input || typeof input !== 'object') return;
    const o = input as Record<string, unknown>;
    const subject = typeof o['subject'] === 'string' ? o['subject'] : undefined;
    if (!subject) return;
    this.tasks.push({
      id: String(this.tasks.length + 1), // 1-indexed creation ordinal
      subject,
      description: typeof o['description'] === 'string' ? o['description'] : undefined,
      activeForm: typeof o['activeForm'] === 'string' ? o['activeForm'] : undefined,
      status: 'pending',
    });
  }

  private onTaskUpdate(input: unknown): void {
    if (!input || typeof input !== 'object') return;
    const o = input as Record<string, unknown>;
    const id = o['taskId'];
    if (id === undefined || id === null) return;
    const key = String(id);
    const task = this.tasks.find((t) => t.id === key);
    if (!task) return; // update for a task we never saw created -- ignore
    task.status = coerceTaskStatus(o['status']);
    if (typeof o['subject'] === 'string') task.subject = o['subject'];
  }

  private onTodoWrite(input: unknown): void {
    if (!input || typeof input !== 'object') return;
    const todos = (input as Record<string, unknown>)['todos'];
    if (!Array.isArray(todos)) return;
    const parsed: Task[] = [];
    todos.forEach((item, i) => {
      const r = todoWriteItem.safeParse(item);
      if (!r.success) return;
      const subject = r.data.content ?? r.data.activeForm;
      if (!subject) return;
      parsed.push({
        id: String(i + 1),
        subject,
        activeForm: r.data.activeForm,
        status: coerceTaskStatus(r.data.status),
      });
    });
    this.todoWrite = parsed; // each call is the complete list; last wins
  }

  result(): Plan {
    if (this.tasks.length > 0) return { source: 'task-tools', tasks: this.tasks };
    if (this.todoWrite && this.todoWrite.length > 0) {
      return { source: 'todo-write', tasks: this.todoWrite };
    }
    return { source: 'none', tasks: [] };
  }
}

// ---------------------------------------------------------------------------
// Session assembly
// ---------------------------------------------------------------------------

export interface ParseOptions {
  /** Cap on retained turns. The full file is still scanned for plan/status. */
  tailLimit?: number;
}

/**
 * Parse a whole transcript body into a ParsedSession.
 *
 * `sessionId` is passed in because it comes from the filename, which is
 * authoritative -- a record's own sessionId can be absent.
 */
export function parseSessionBody(
  body: string,
  sessionId: string,
  options: ParseOptions = {},
): ParsedSession {
  const tailLimit = options.tailLimit ?? TRANSCRIPT_TAIL_LIMIT;
  const lines = body.split('\n');

  const plan = new PlanAccumulator();
  const turns: Turn[] = [];

  let cwd: string | undefined;
  const cwds: string[] = [];
  let gitBranch: string | undefined;
  let version: string | undefined;
  let entrypoint: string | undefined;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let lastPrompt: string | undefined;
  let firstTimestamp: Date | undefined;
  let lastTimestamp: Date | undefined;
  let turnCount = 0;
  let malformedLines = 0;
  let lastStopReason: string | undefined;

  // Tool bookkeeping: which tool_use ids are still awaiting a result.
  const pendingToolUses = new Set<string>();
  const seenToolResults = new Set<string>();
  /** ids emitted by the FINAL assistant record -- what "ends mid-work" tests. */
  let finalAssistantToolIds: string[] = [];
  let lastSubstantiveType: 'user' | 'assistant' | null = null;
  let lastToolErrored = false;
  let lastToolRejectedByUser = false;
  let lastAssistantText: string | undefined;
  const prLinks: PrLink[] = [];
  /** tool_use id -> (name, question) for the FINAL assistant record. */
  let finalAssistantTools = new Map<string, { name: string; question?: PendingQuestion }>();

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const rec = parseLine(line);
    if (rec === null) {
      // Only count lines that looked like JSON but we could not use, so that
      // the 688 `attachment` records etc. do not read as corruption.
      if (line.trim().startsWith('{') && !isKnownIgnorableType(line)) malformedLines++;
      continue;
    }

    // Metadata records: last occurrence wins (a new one is appended on each
    // regeneration, so the first is stale).
    if (rec.type === 'ai-title') {
      aiTitle = rec.aiTitle;
      continue;
    }
    if (rec.type === 'custom-title') {
      customTitle = rec.customTitle;
      continue;
    }
    if (rec.type === 'last-prompt') {
      lastPrompt = rec.lastPrompt;
      continue;
    }
    if (rec.type === 'pr-link') {
      prLinks.push({
        number: rec.prNumber,
        url: rec.prUrl,
        repository: rec.prRepository,
        timestamp: rec.timestamp,
      });
      continue;
    }

    // Subagent turns never belong to the parent transcript. Belt and braces --
    // the real defence is excluding subagents/ during discovery.
    if ('isSidechain' in rec && rec.isSidechain === true) continue;

    // Envelope fields: last non-empty value wins, because cwd can change
    // mid-session and only *some* record types carry these at all.
    if ('cwd' in rec && rec.cwd) {
      cwd = rec.cwd;
      if (!cwds.includes(rec.cwd)) cwds.push(rec.cwd);
    }
    if ('gitBranch' in rec && rec.gitBranch) gitBranch = rec.gitBranch;
    if ('version' in rec && rec.version) version = rec.version;
    if ('entrypoint' in rec && rec.entrypoint) entrypoint = rec.entrypoint;
    if ('timestamp' in rec && rec.timestamp instanceof Date) {
      if (!firstTimestamp) firstTimestamp = rec.timestamp;
      lastTimestamp = rec.timestamp;
    }

    const ts = 'timestamp' in rec ? rec.timestamp : undefined;

    if (rec.type === 'assistant') {
      turnCount++;
      lastSubstantiveType = 'assistant';
      lastStopReason = rec.message.stop_reason ?? undefined;
      const emitted: string[] = [];
      const tools = new Map<string, { name: string; question?: PendingQuestion }>();

      for (const block of blocksOf(rec)) {
        if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
          const text = block.text.trim();
          if (text) {
            lastAssistantText = flatten(text);
            turns.push({ role: 'assistant', text: lastAssistantText, timestamp: ts });
          }
        } else if (block.type === 'tool_use' && 'name' in block) {
          const b = block as z.infer<typeof toolUseBlock>;
          plan.observe(b.name, b.input);
          if (b.id) {
            pendingToolUses.add(b.id);
            emitted.push(b.id);
            tools.set(b.id, {
              name: b.name,
              question: b.name === 'AskUserQuestion' ? toPendingQuestion(b.input) : undefined,
            });
          }
          turns.push({
            role: 'tool_use',
            text: flatten(summariseToolUse(b.name, b.input)),
            toolName: b.name,
            timestamp: ts,
          });
        }
      }
      finalAssistantToolIds = emitted;
      finalAssistantTools = tools;
    } else if (rec.type === 'user') {
      turnCount++;
      lastSubstantiveType = 'user';
      const content = rec.message.content;

      if (typeof content === 'string') {
        const text = content.trim();
        if (text) turns.push({ role: 'user', text: flatten(text), timestamp: ts });
      } else {
        for (const block of blocksOf(rec)) {
          if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
            const text = block.text.trim();
            if (text) turns.push({ role: 'user', text: flatten(text), timestamp: ts });
          } else if (block.type === 'tool_result') {
            const b = block as z.infer<typeof toolResultBlock>;
            if (b.tool_use_id) {
              seenToolResults.add(b.tool_use_id);
              pendingToolUses.delete(b.tool_use_id);
            }
            // Only `true` is a failure. `null` means the field was not written.
            const isError = b.is_error === true;
            const resultText = flatten(stringifyToolResult(b.content));
            lastToolErrored = isError;
            lastToolRejectedByUser = isError && isUserRejection(resultText);
            turns.push({
              role: 'tool_result',
              text: resultText || (isError ? 'error' : 'ok'),
              isError,
              timestamp: ts,
            });
          }
        }
      }
    } else if (rec.type === 'system') {
      // Kept out of the transcript tail: hook summaries are noise for a viewer.
      continue;
    }

    // Trim as we go so a 2.8 MB file never holds 5000 turns in memory.
    if (turns.length > tailLimit * 2) turns.splice(0, turns.length - tailLimit);
  }

  // The first call of the final assistant record still awaiting a result. When
  // it is an AskUserQuestion, the human owes an answer -- that is not "Claude is
  // working", it is "you are holding things up", and the project view says so.
  const unansweredId = finalAssistantToolIds.find((id) => !seenToolResults.has(id));
  const unanswered = unansweredId ? finalAssistantTools.get(unansweredId) : undefined;
  const pendingToolName = lastSubstantiveType === 'assistant' ? unanswered?.name : undefined;
  const pendingQuestion = lastSubstantiveType === 'assistant' ? unanswered?.question : undefined;

  const endsMidWork =
    (lastSubstantiveType === 'assistant' &&
      lastStopReason === 'tool_use' &&
      finalAssistantToolIds.some((id) => !seenToolResults.has(id))) ||
    lastSubstantiveType === 'user';

  return {
    sessionId,
    cwd,
    cwds,
    gitBranch,
    version,
    entrypoint,
    customTitle,
    aiTitle,
    lastPrompt,
    firstTimestamp,
    lastTimestamp,
    turnCount,
    turns: turns.slice(-tailLimit),
    plan: plan.result(),
    lastStopReason,
    endsMidWork,
    lastToolErrored,
    lastToolRejectedByUser,
    lastAssistantText,
    pendingToolName,
    pendingQuestion,
    prLinks,
    malformedLines,
  };
}

/** Record types we knowingly skip -- not corruption, just uninteresting. */
const IGNORABLE_TYPES = [
  'attachment',
  'mode',
  'atis-latch',
  'bridge-session',
  'queue-operation',
  'permission-mode',
  'file-history-snapshot',
  'file-history-delta',
  'frame-link',
  'pr-link',
  'artifact-autoreact-ledger',
  'artifact-comment-monitor',
  'summary',
];
// 'pr-link' is parsed, not ignored.

function isKnownIgnorableType(line: string): boolean {
  return IGNORABLE_TYPES.some((t) => line.includes(`"type":"${t}"`));
}

/**
 * A declined permission prompt also lands as `is_error: true`, but the session
 * did not fail -- the human said no. Both "failed" sessions on the machine this
 * was built against were actually this. Detected by the sentinel Claude Code
 * writes as the tool_result body.
 */
const USER_REJECTION_MARKERS = [
  "The user doesn't want to proceed with this tool use",
  'The user doesn\u2019t want to proceed with this tool use',
  'The user rejected',
  'tool use was rejected',
  'User rejected',
];

export function isUserRejection(resultText: string): boolean {
  if (!resultText) return false;
  return USER_REJECTION_MARKERS.some((m) => resultText.includes(m));
}

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Title precedence: user-set > generated > first prompt > id prefix. */
export function resolveTitle(s: ParsedSession): string {
  return (
    s.customTitle?.trim() ||
    s.aiTitle?.trim() ||
    s.lastPrompt?.trim() ||
    s.sessionId.slice(0, 8)
  );
}

/** Last thing the assistant said -- the root view's snippet column. */
export function resolveSnippet(s: ParsedSession): string {
  for (let i = s.turns.length - 1; i >= 0; i--) {
    const turn = s.turns[i];
    if (turn && turn.role === 'assistant' && turn.text) return turn.text;
  }
  for (let i = s.turns.length - 1; i >= 0; i--) {
    const turn = s.turns[i];
    if (turn && turn.role === 'tool_use' && turn.text) return turn.text;
  }
  return '';
}
