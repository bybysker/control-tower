#!/usr/bin/env node

// src/cli.tsx
import "react";
import { render } from "ink";
import { Command, InvalidArgumentError } from "commander";

// src/app.tsx
import { useEffect as useEffect2, useMemo as useMemo2, useState as useState2 } from "react";
import { Box as Box7, useApp as useApp2, useStdout } from "ink";
import { Spinner } from "@inkjs/ui";

// src/hooks/useSessions.ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// src/data/discover.ts
import fs3 from "node:fs/promises";
import { createReadStream } from "node:fs";
import path4 from "node:path";

// src/data/parse.ts
import { z } from "zod";

// src/data/types.ts
var TRANSCRIPT_TAIL_LIMIT = 200;

// src/data/parse.ts
var isoDate = z.string().transform((s) => new Date(s)).refine((d) => !Number.isNaN(d.getTime()), { message: "invalid timestamp" });
var textBlock = z.object({ type: z.literal("text"), text: z.string() });
var thinkingBlock = z.object({ type: z.literal("thinking") });
var toolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string().optional(),
  name: z.string(),
  input: z.unknown().optional()
});
var toolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string().optional(),
  // `content` is a string, or an array of blocks, depending on the tool.
  content: z.unknown().optional(),
  // null on 561 of 1047 observed blocks -- null is NOT a failure.
  is_error: z.boolean().nullish()
});
var contentBlock = z.union([
  textBlock,
  thinkingBlock,
  toolUseBlock,
  toolResultBlock,
  z.object({ type: z.string() }).passthrough()
]);
var envelope = {
  uuid: z.string().optional(),
  parentUuid: z.string().nullish(),
  sessionId: z.string().optional(),
  timestamp: isoDate.optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  version: z.string().optional(),
  entrypoint: z.string().optional(),
  isSidechain: z.boolean().optional()
};
var assistantRecord = z.object({
  type: z.literal("assistant"),
  ...envelope,
  message: z.object({
    role: z.string().optional(),
    model: z.string().optional(),
    content: z.array(contentBlock).optional(),
    stop_reason: z.string().nullish()
  }).passthrough()
});
var userRecord = z.object({
  type: z.literal("user"),
  ...envelope,
  message: z.object({
    role: z.string().optional(),
    // Either a typed prompt (string) or an array of blocks.
    content: z.union([z.string(), z.array(contentBlock)]).optional()
  }).passthrough()
});
var systemRecord = z.object({
  type: z.literal("system"),
  ...envelope,
  subtype: z.string().optional(),
  level: z.string().optional()
});
var aiTitleRecord = z.object({ type: z.literal("ai-title"), aiTitle: z.string() });
var customTitleRecord = z.object({ type: z.literal("custom-title"), customTitle: z.string() });
var lastPromptRecord = z.object({ type: z.literal("last-prompt"), lastPrompt: z.string() });
var prLinkRecord = z.object({
  type: z.literal("pr-link"),
  prNumber: z.number(),
  prUrl: z.string(),
  prRepository: z.string().optional(),
  timestamp: isoDate.optional()
});
function parseLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const type = raw.type;
  if (typeof type !== "string") return null;
  switch (type) {
    case "assistant": {
      const r = assistantRecord.safeParse(raw);
      return r.success ? r.data : null;
    }
    case "user": {
      const r = userRecord.safeParse(raw);
      return r.success ? r.data : null;
    }
    case "system": {
      const r = systemRecord.safeParse(raw);
      return r.success ? r.data : null;
    }
    case "ai-title": {
      const r = aiTitleRecord.safeParse(raw);
      return r.success ? r.data : null;
    }
    case "custom-title": {
      const r = customTitleRecord.safeParse(raw);
      return r.success ? r.data : null;
    }
    case "last-prompt": {
      const r = lastPromptRecord.safeParse(raw);
      return r.success ? r.data : null;
    }
    case "pr-link": {
      const r = prLinkRecord.safeParse(raw);
      return r.success ? r.data : null;
    }
    default:
      return null;
  }
}
function blocksOf(rec) {
  if (rec.type !== "assistant" && rec.type !== "user") return [];
  const content = rec.message?.content;
  if (Array.isArray(content)) return content;
  return [];
}
function stringifyToolResult(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(
      (b) => b && typeof b === "object" && "text" in b && typeof b.text === "string" ? b.text : ""
    ).filter(Boolean).join(" ");
  }
  if (content && typeof content === "object") {
    const o = content;
    if (typeof o["stdout"] === "string") return o["stdout"];
  }
  return "";
}
function summariseToolUse(name, input) {
  if (!input || typeof input !== "object") return name;
  const o = input;
  if (name === "AskUserQuestion") {
    const q = toPendingQuestion(input);
    if (q) return `${name}: ${q.question}`;
  }
  if (name === "TaskUpdate" && o["taskId"] !== void 0) {
    return `${name}: #${String(o["taskId"])} ${typeof o["status"] === "string" ? o["status"] : ""}`.trim();
  }
  const interesting = ["command", "file_path", "pattern", "path", "subject", "prompt", "url", "query"];
  for (const key of interesting) {
    const v = o[key];
    if (typeof v === "string" && v.length > 0) return `${name}: ${v}`;
  }
  return name;
}
var askUserQuestionInput = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      header: z.string().optional(),
      options: z.array(z.object({ label: z.string() })).optional()
    })
  ).min(1)
});
function toPendingQuestion(input) {
  const r = askUserQuestionInput.safeParse(input);
  if (!r.success) return void 0;
  const q = r.data.questions[0];
  if (!q) return void 0;
  return { question: q.question, header: q.header, options: (q.options ?? []).map((o) => o.label) };
}
var taskStatuses = ["pending", "in_progress", "completed"];
function coerceTaskStatus(v) {
  return typeof v === "string" && taskStatuses.includes(v) ? v : "pending";
}
var todoWriteItem = z.object({
  content: z.string().optional(),
  activeForm: z.string().optional(),
  status: z.string().optional()
});
var PlanAccumulator = class {
  tasks = [];
  todoWrite = null;
  observe(name, input) {
    if (name === "TaskCreate") this.onTaskCreate(input);
    else if (name === "TaskUpdate") this.onTaskUpdate(input);
    else if (name === "TodoWrite") this.onTodoWrite(input);
  }
  onTaskCreate(input) {
    if (!input || typeof input !== "object") return;
    const o = input;
    const subject = typeof o["subject"] === "string" ? o["subject"] : void 0;
    if (!subject) return;
    this.tasks.push({
      id: String(this.tasks.length + 1),
      // 1-indexed creation ordinal
      subject,
      description: typeof o["description"] === "string" ? o["description"] : void 0,
      activeForm: typeof o["activeForm"] === "string" ? o["activeForm"] : void 0,
      status: "pending"
    });
  }
  onTaskUpdate(input) {
    if (!input || typeof input !== "object") return;
    const o = input;
    const id = o["taskId"];
    if (id === void 0 || id === null) return;
    const key = String(id);
    const task = this.tasks.find((t) => t.id === key);
    if (!task) return;
    task.status = coerceTaskStatus(o["status"]);
    if (typeof o["subject"] === "string") task.subject = o["subject"];
  }
  onTodoWrite(input) {
    if (!input || typeof input !== "object") return;
    const todos = input["todos"];
    if (!Array.isArray(todos)) return;
    const parsed = [];
    todos.forEach((item, i) => {
      const r = todoWriteItem.safeParse(item);
      if (!r.success) return;
      const subject = r.data.content ?? r.data.activeForm;
      if (!subject) return;
      parsed.push({
        id: String(i + 1),
        subject,
        activeForm: r.data.activeForm,
        status: coerceTaskStatus(r.data.status)
      });
    });
    this.todoWrite = parsed;
  }
  result() {
    if (this.tasks.length > 0) return { source: "task-tools", tasks: this.tasks };
    if (this.todoWrite && this.todoWrite.length > 0) {
      return { source: "todo-write", tasks: this.todoWrite };
    }
    return { source: "none", tasks: [] };
  }
};
function parseSessionBody(body, sessionId, options = {}) {
  const tailLimit = options.tailLimit ?? TRANSCRIPT_TAIL_LIMIT;
  const lines = body.split("\n");
  const plan = new PlanAccumulator();
  const turns = [];
  let cwd;
  const cwds = [];
  let gitBranch;
  let version;
  let entrypoint;
  let customTitle;
  let aiTitle;
  let lastPrompt;
  let firstTimestamp;
  let lastTimestamp;
  let turnCount = 0;
  let malformedLines = 0;
  let lastStopReason;
  const pendingToolUses = /* @__PURE__ */ new Set();
  const seenToolResults = /* @__PURE__ */ new Set();
  let finalAssistantToolIds = [];
  let lastSubstantiveType = null;
  let lastToolErrored = false;
  let lastToolRejectedByUser = false;
  let lastAssistantText;
  const prLinks = [];
  let finalAssistantTools = /* @__PURE__ */ new Map();
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const rec = parseLine(line);
    if (rec === null) {
      if (line.trim().startsWith("{") && !isKnownIgnorableType(line)) malformedLines++;
      continue;
    }
    if (rec.type === "ai-title") {
      aiTitle = rec.aiTitle;
      continue;
    }
    if (rec.type === "custom-title") {
      customTitle = rec.customTitle;
      continue;
    }
    if (rec.type === "last-prompt") {
      lastPrompt = rec.lastPrompt;
      continue;
    }
    if (rec.type === "pr-link") {
      prLinks.push({
        number: rec.prNumber,
        url: rec.prUrl,
        repository: rec.prRepository,
        timestamp: rec.timestamp
      });
      continue;
    }
    if ("isSidechain" in rec && rec.isSidechain === true) continue;
    if ("cwd" in rec && rec.cwd) {
      cwd = rec.cwd;
      if (!cwds.includes(rec.cwd)) cwds.push(rec.cwd);
    }
    if ("gitBranch" in rec && rec.gitBranch) gitBranch = rec.gitBranch;
    if ("version" in rec && rec.version) version = rec.version;
    if ("entrypoint" in rec && rec.entrypoint) entrypoint = rec.entrypoint;
    if ("timestamp" in rec && rec.timestamp instanceof Date) {
      if (!firstTimestamp) firstTimestamp = rec.timestamp;
      lastTimestamp = rec.timestamp;
    }
    const ts = "timestamp" in rec ? rec.timestamp : void 0;
    if (rec.type === "assistant") {
      turnCount++;
      lastSubstantiveType = "assistant";
      lastStopReason = rec.message.stop_reason ?? void 0;
      const emitted = [];
      const tools = /* @__PURE__ */ new Map();
      for (const block of blocksOf(rec)) {
        if (block.type === "text" && "text" in block && typeof block.text === "string") {
          const text = block.text.trim();
          if (text) {
            lastAssistantText = flatten(text);
            turns.push({ role: "assistant", text: lastAssistantText, timestamp: ts });
          }
        } else if (block.type === "tool_use" && "name" in block) {
          const b = block;
          plan.observe(b.name, b.input);
          if (b.id) {
            pendingToolUses.add(b.id);
            emitted.push(b.id);
            tools.set(b.id, {
              name: b.name,
              question: b.name === "AskUserQuestion" ? toPendingQuestion(b.input) : void 0
            });
          }
          turns.push({
            role: "tool_use",
            text: flatten(summariseToolUse(b.name, b.input)),
            toolName: b.name,
            timestamp: ts
          });
        }
      }
      finalAssistantToolIds = emitted;
      finalAssistantTools = tools;
    } else if (rec.type === "user") {
      turnCount++;
      lastSubstantiveType = "user";
      const content = rec.message.content;
      if (typeof content === "string") {
        const text = content.trim();
        if (text) turns.push({ role: "user", text: flatten(text), timestamp: ts });
      } else {
        for (const block of blocksOf(rec)) {
          if (block.type === "text" && "text" in block && typeof block.text === "string") {
            const text = block.text.trim();
            if (text) turns.push({ role: "user", text: flatten(text), timestamp: ts });
          } else if (block.type === "tool_result") {
            const b = block;
            if (b.tool_use_id) {
              seenToolResults.add(b.tool_use_id);
              pendingToolUses.delete(b.tool_use_id);
            }
            const isError = b.is_error === true;
            const resultText = flatten(stringifyToolResult(b.content));
            lastToolErrored = isError;
            lastToolRejectedByUser = isError && isUserRejection(resultText);
            turns.push({
              role: "tool_result",
              text: resultText || (isError ? "error" : "ok"),
              isError,
              timestamp: ts
            });
          }
        }
      }
    } else if (rec.type === "system") {
      continue;
    }
    if (turns.length > tailLimit * 2) turns.splice(0, turns.length - tailLimit);
  }
  const unansweredId = finalAssistantToolIds.find((id) => !seenToolResults.has(id));
  const unanswered = unansweredId ? finalAssistantTools.get(unansweredId) : void 0;
  const pendingToolName = lastSubstantiveType === "assistant" ? unanswered?.name : void 0;
  const pendingQuestion = lastSubstantiveType === "assistant" ? unanswered?.question : void 0;
  const endsMidWork = lastSubstantiveType === "assistant" && lastStopReason === "tool_use" && finalAssistantToolIds.some((id) => !seenToolResults.has(id)) || lastSubstantiveType === "user";
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
    malformedLines
  };
}
var IGNORABLE_TYPES = [
  "attachment",
  "mode",
  "atis-latch",
  "bridge-session",
  "queue-operation",
  "permission-mode",
  "file-history-snapshot",
  "file-history-delta",
  "frame-link",
  "pr-link",
  "artifact-autoreact-ledger",
  "artifact-comment-monitor",
  "summary"
];
function isKnownIgnorableType(line) {
  return IGNORABLE_TYPES.some((t) => line.includes(`"type":"${t}"`));
}
var USER_REJECTION_MARKERS = [
  "The user doesn't want to proceed with this tool use",
  "The user doesn\u2019t want to proceed with this tool use",
  "The user rejected",
  "tool use was rejected",
  "User rejected"
];
function isUserRejection(resultText) {
  if (!resultText) return false;
  return USER_REJECTION_MARKERS.some((m) => resultText.includes(m));
}
function flatten(text) {
  return text.replace(/\s+/g, " ").trim();
}
function resolveTitle(s) {
  return s.customTitle?.trim() || s.aiTitle?.trim() || s.lastPrompt?.trim() || s.sessionId.slice(0, 8);
}
function resolveSnippet(s) {
  for (let i = s.turns.length - 1; i >= 0; i--) {
    const turn = s.turns[i];
    if (turn && turn.role === "assistant" && turn.text) return turn.text;
  }
  for (let i = s.turns.length - 1; i >= 0; i--) {
    const turn = s.turns[i];
    if (turn && turn.role === "tool_use" && turn.text) return turn.text;
  }
  return "";
}

// src/data/status.ts
var RUNNING_WINDOW_MS = 1e4;
var STALLED_AFTER_MS = 30 * 60 * 1e3;
function deriveStatus(parsed, lastActivity, now = /* @__PURE__ */ new Date()) {
  const age = now.getTime() - lastActivity.getTime();
  if (age < RUNNING_WINDOW_MS && parsed.endsMidWork) return "running";
  if (parsed.lastToolErrored && !parsed.lastToolRejectedByUser) return "failed";
  if (parsed.lastStopReason === "end_turn" && !parsed.endsMidWork) return "done";
  if (age > STALLED_AFTER_MS) return "stalled";
  return "idle";
}
var STATUS_RANK = {
  running: 0,
  failed: 1,
  idle: 2,
  done: 3,
  stalled: 4
};

// src/data/project.ts
import fs from "node:fs/promises";
import path2 from "node:path";

// src/utils/format.ts
import { formatDistanceStrict } from "date-fns";
import stringWidth from "string-width";
function timeAgo(date, now = /* @__PURE__ */ new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "\u2014";
  const deltaMs = now.getTime() - date.getTime();
  if (deltaMs >= 0 && deltaMs < 1e3) return "now";
  const raw = formatDistanceStrict(date, now, { addSuffix: false });
  return raw.replace(/ seconds?$/, "s").replace(/ minutes?$/, "m").replace(/ hours?$/, "h").replace(/ days?$/, "d").replace(/ months?$/, "mo").replace(/ years?$/, "y");
}
function truncate(text, max) {
  const flat = sanitizeWidth(text.replace(/\s+/g, " ").trim());
  if (max <= 0) return "";
  if (stringWidth(flat) <= max) return flat;
  if (max === 1) return "\u2026";
  let out = "";
  let width = 0;
  for (const char of flat) {
    const w = stringWidth(char);
    if (width + w > max - 1) break;
    out += char;
    width += w;
  }
  return out + "\u2026";
}
function truncateStart(text, max) {
  const flat = sanitizeWidth(text.replace(/\s+/g, " ").trim());
  if (max <= 0) return "";
  if (stringWidth(flat) <= max) return flat;
  if (max === 1) return "\u2026";
  const chars = [...flat];
  let out = "";
  let width = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i];
    if (ch === void 0) break;
    const w = stringWidth(ch);
    if (width + w > max - 1) break;
    out = ch + out;
    width += w;
  }
  return "\u2026" + out;
}
function fit(text, width) {
  const t = truncate(text, width);
  return t + " ".repeat(Math.max(0, width - stringWidth(t)));
}
var columns = stringWidth;
function sanitizeWidth(text) {
  let out = "";
  for (const ch of text) {
    const w = stringWidth(ch);
    if (w === 0) continue;
    out += w >= 2 ? "\xB7" : ch;
  }
  return out;
}
function colorForStatus(status) {
  switch (status) {
    case "running":
      return "yellow";
    case "done":
      return "green";
    case "failed":
      return "red";
    case "stalled":
      return "magenta";
    case "idle":
    default:
      return "gray";
  }
}
function glyphForStatus(status) {
  switch (status) {
    case "running":
      return "\u25CF";
    case "done":
      return "\u2713";
    case "failed":
      return "\u2717";
    case "stalled":
      return "\u2026";
    case "idle":
    default:
      return "\u25CB";
  }
}
function glyphForTask(status) {
  switch (status) {
    case "completed":
      return "\u2713";
    case "in_progress":
      return "\u25CF";
    case "pending":
    default:
      return "\u25CB";
  }
}
function colorForTask(status) {
  switch (status) {
    case "completed":
      return "green";
    case "in_progress":
      return "yellow";
    case "pending":
    default:
      return "gray";
  }
}
function colorForProject(status) {
  return status === "action" ? "redBright" : colorForStatus(status);
}
function glyphForProject(status) {
  return status === "action" ? "!" : glyphForStatus(status);
}
function labelForAction(kind) {
  switch (kind) {
    case "answer":
      return "answer";
    case "failed":
      return "fix";
    case "permission":
      return "unblock";
    case "reply":
    default:
      return "reply";
  }
}
function agoLabel(date, now = /* @__PURE__ */ new Date()) {
  const t = timeAgo(date, now);
  return t === "now" || t === "\u2014" ? t : `${t} ago`;
}
function glyphForStep(step) {
  if (step.source === "plan") return glyphForTask(step.status ?? "pending");
  return step.source === "git" ? "\u2192" : "\u2234";
}
function colorForStep(step) {
  if (step.source === "plan") return colorForTask(step.status ?? "pending");
  return step.source === "git" ? "cyan" : "yellow";
}

// src/data/actions.ts
function deriveActions(session, now = /* @__PURE__ */ new Date()) {
  const out = [];
  const base = { sessionId: session.sessionId, sessionTitle: session.title, since: session.lastActivity };
  const age = now.getTime() - session.lastActivity.getTime();
  if (session.pendingQuestion) {
    out.push({
      ...base,
      kind: "answer",
      label: session.pendingQuestion.question,
      options: session.pendingQuestion.options
    });
    return out;
  }
  if (session.status === "failed") {
    const last = [...session.turns].reverse().find((t) => t.role === "tool_result" && t.isError);
    out.push({ ...base, kind: "failed", label: last ? truncate(last.text, 120) : "last tool call failed" });
    return out;
  }
  if (session.pendingToolName && age >= RUNNING_WINDOW_MS && !session.lastToolRejectedByUser) {
    out.push({
      ...base,
      kind: "permission",
      label: `${session.pendingToolName} is waiting for a result -- permission prompt, or the process died`
    });
    return out;
  }
  const text = session.lastAssistantText?.trim();
  if (text && text.endsWith("?") && !session.endsMidWork) {
    out.push({ ...base, kind: "reply", label: lastSentence(text) });
  }
  return out;
}
function lastSentence(text) {
  const parts = text.split(/(?<=[.!?])\s+/);
  const tail = parts[parts.length - 1] ?? text;
  return truncate(tail, 160);
}

// src/data/plan.ts
function planProgress(plan) {
  return {
    completed: plan.tasks.filter((t) => t.status === "completed").length,
    total: plan.tasks.length
  };
}
function taskLabel(task) {
  if (task.status === "in_progress" && task.activeForm) return task.activeForm;
  return task.subject;
}

// src/data/nextsteps.ts
var TRUNK = /* @__PURE__ */ new Set(["main", "master", "trunk", "develop", "HEAD"]);
function planSteps(plan) {
  const pick = (status) => plan.tasks.filter((t) => t.status === status).map((t) => ({ source: "plan", id: `plan-${t.id}`, label: taskLabel(t), status: t.status }));
  return [...pick("in_progress"), ...pick("pending")];
}
function gitSteps(git) {
  if (!git || git.notARepo) return [];
  const out = [];
  const step = (id, label) => {
    out.push({ source: "git", id: `git-${id}`, label });
  };
  if (git.changed > 0) {
    step("commit", `Commit or stash ${git.changed} changed file${git.changed === 1 ? "" : "s"}`);
  }
  if (git.ahead && git.ahead > 0) {
    step("push", `Push ${git.ahead} commit${git.ahead === 1 ? "" : "s"} to origin/${git.branch ?? "HEAD"}`);
  }
  if (git.ahead === void 0 && git.branch && !TRUNK.has(git.branch)) {
    step("publish", `Publish branch ${git.branch} \u2014 it has no upstream`);
  } else if (git.branch && !TRUNK.has(git.branch) && !git.dirty && !git.ahead) {
    step("land", `Land ${git.branch} \u2014 clean and pushed, still off trunk`);
  }
  if (git.behind && git.behind > 0) {
    step("pull", `Pull ${git.behind} commit${git.behind === 1 ? "" : "s"} from origin/${git.branch ?? "HEAD"}`);
  }
  if (out.length === 0 && git.untracked > 0) {
    step("untracked", `${git.untracked} untracked file${git.untracked === 1 ? "" : "s"} \u2014 add or ignore`);
  }
  return out;
}
function deriveNextSteps(sessions, git) {
  const byRecency = [...sessions].sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
  const planned = byRecency.find((s) => s.plan.tasks.length > 0);
  return [...planned ? planSteps(planned.plan) : [], ...gitSteps(git)];
}

// src/utils/paths.ts
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
function resolveClaudeHome(override) {
  if (override && override.trim().length > 0) {
    return path.resolve(expandTilde(override.trim()));
  }
  return path.join(os.homedir(), ".claude");
}
function expandTilde(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
function projectsRoot(claudeHome) {
  return path.join(claudeHome, "projects");
}
function encodeProjectDir(absPath) {
  return absPath.replace(/\/+$/, "").replace(/[/.]/g, "-");
}
function decodeProjectDir(dir) {
  const withoutLeading = dir.replace(/^-/, "");
  return "/" + withoutLeading.replace(/-/g, "/");
}
function resolveProjectPath(dir, candidates) {
  let shortestFallback;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (encodeProjectDir(candidate) === dir) return candidate;
    if (!shortestFallback || candidate.length < shortestFallback.length) {
      shortestFallback = candidate;
    }
  }
  return shortestFallback ?? decodeProjectDir(dir);
}
function projectLabel(absPath, homeDir = os.homedir()) {
  const normalised = absPath.replace(/\/+$/, "");
  const base = path.basename(normalised);
  if (!base) return normalised || "/";
  const parent = path.dirname(normalised);
  if (parent === homeDir) return base;
  return base;
}
function cacheDir() {
  const base = process.env["XDG_CACHE_HOME"] || path.join(os.homedir(), ".cache");
  return path.join(base, "control-tower");
}
function summaryRunnerDir() {
  return path.join(cacheDir(), "runner");
}
var RUNNER_DIR_SUFFIX = "-control-tower-runner";
function isRunnerProjectDir(dir) {
  return dir.endsWith(RUNNER_DIR_SUFFIX);
}
function pluginDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.basename(here) === "dist" ? path.join(here, "..") : path.join(here, "..", "..");
  return path.join(candidate, "plugin");
}

// src/data/project.ts
var PROJECT_STATUS_RANK = {
  action: 0,
  failed: 1,
  running: 2,
  idle: 3,
  done: 4,
  stalled: 5
};
var ACTION_RANK = {
  answer: 0,
  failed: 1,
  permission: 2,
  reply: 3
};
var ACTION_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1e3;
function deriveSupervision(sessions, now = /* @__PURE__ */ new Date(), git, memory = [], userTasks = []) {
  const byRecency = [...sessions].sort(
    (a, b) => b.lastActivity.getTime() - a.lastActivity.getTime()
  );
  const latestId = byRecency[0]?.sessionId;
  const actions = byRecency.flatMap((s) => deriveActions(s, now)).filter((a) => a.kind !== "reply" || a.sessionId === latestId).filter((a) => now.getTime() - a.since.getTime() < ACTION_STALE_AFTER_MS).sort((a, b) => ACTION_RANK[a.kind] - ACTION_RANK[b.kind] || b.since.getTime() - a.since.getTime());
  const latest = byRecency[0];
  const whereWeAre = latest && latest.lastAssistantText ? { text: latest.lastAssistantText, sessionId: latest.sessionId, at: latest.lastActivity } : void 0;
  const nextSteps = deriveNextSteps(byRecency, git);
  const seen = /* @__PURE__ */ new Set();
  const prLinks = [];
  for (const s of byRecency) {
    for (const pr of [...s.prLinks].reverse()) {
      if (seen.has(pr.url)) continue;
      seen.add(pr.url);
      prLinks.push(pr);
    }
  }
  let status = "idle";
  if (actions.length > 0) status = "action";
  else if (sessions.length > 0) {
    status = sessions.map((s) => s.status).reduce((best, s) => STATUS_RANK[s] < STATUS_RANK[best] ? s : best);
  }
  return { status, actions, whereWeAre, nextSteps, prLinks, git, memory, userTasks };
}
async function readProjectMemory(claudeHome, projectDir) {
  const file = path2.join(projectsRoot(claudeHome), projectDir, "memory", "MEMORY.md");
  let body;
  try {
    body = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  return body.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim()).filter(Boolean).slice(0, 8);
}
function compareProjects(a, b) {
  return PROJECT_STATUS_RANK[a.supervision.status] - PROJECT_STATUS_RANK[b.supervision.status] || b.lastActivity.getTime() - a.lastActivity.getTime();
}
function describeGit(git) {
  if (!git || git.notARepo) return "";
  const parts = [];
  if (git.branch) parts.push(git.branch);
  if (git.dirty) parts.push("dirty");
  if (git.ahead) parts.push(`\u2191${git.ahead}`);
  if (git.behind) parts.push(`\u2193${git.behind}`);
  return parts.join(" \xB7 ");
}

// src/data/usertasks.ts
import { execFile } from "node:child_process";
import fs2 from "node:fs/promises";
import path3 from "node:path";
var EXAMPLE_NAMES = [".env.example", ".env.sample", ".env.template", "env.example"];
var ENV_NAMES = [".env", ".env.local"];
var GIT_TIMEOUT_MS = 5e3;
function parseAssignments(body) {
  const out = /* @__PURE__ */ new Map();
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    const filled = value.length > 0 && !/^(changeme|xxx+|your[-_ ]?|<.*>|\.\.\.)$/i.test(value);
    out.set(key, out.get(key) === true ? true : filled);
  }
  return out;
}
async function readFirst(dir, names) {
  for (const n of names) {
    try {
      return await fs2.readFile(path3.join(dir, n), "utf8");
    } catch {
      continue;
    }
  }
  return void 0;
}
var HUMAN_ONLY = /(_API_KEY|_ACCESS_TOKEN|_APP_SECRET|_SECRET_KEY|_PUBLIC_KEY|_PRIVATE_KEY|_CLIENT_ID|_CLIENT_SECRET|_VERIFY_TOKEN|_PUBLISH_PROFILE|_CREDENTIALS|_CREDENTIALS_PATH|_ACCESS_KEY|_PHONE_NUMBER_ID|_DSN|_WEBHOOK_URL|_ENDPOINT|_MEASUREMENT_ID)$/;
function isHumanOnly(key) {
  return HUMAN_ONLY.test(key);
}
function envTask(key, blocking) {
  return {
    source: "env",
    id: `env-${key}`,
    key,
    label: `Get ${key} and put it in .env`,
    blocking
  };
}
async function readEnvFinding(projectPath) {
  const example = await readFirst(projectPath, EXAMPLE_NAMES);
  if (example === void 0) return { missing: [], noEnvFile: false, noExample: true };
  const expected = [...parseAssignments(example).keys()];
  const actual = await readFirst(projectPath, ENV_NAMES);
  if (actual === void 0) return { missing: expected, noEnvFile: true, noExample: false };
  const have = parseAssignments(actual);
  return {
    missing: expected.filter((k) => have.get(k) !== true),
    noEnvFile: false,
    noExample: false
  };
}
function referencedSecrets(workflowBodies) {
  const found = /* @__PURE__ */ new Set();
  for (const body of workflowBodies) {
    for (const m of body.matchAll(/secrets\.([A-Z_][A-Z0-9_]*)/g)) {
      const name = m[1];
      if (name && name !== "GITHUB_TOKEN") found.add(name);
    }
  }
  return [...found].sort();
}
async function readWorkflows(projectPath) {
  const dir = path3.join(projectPath, ".github", "workflows");
  try {
    const names = await fs2.readdir(dir);
    return await Promise.all(
      names.filter((n) => n.endsWith(".yml") || n.endsWith(".yaml")).map((n) => fs2.readFile(path3.join(dir, n), "utf8"))
    );
  } catch {
    return [];
  }
}
function listSecrets(cwd) {
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["secret", "list", "--json", "name", "-q", ".[].name"],
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(void 0);
        resolve(stdout.split("\n").map((l) => l.trim()).filter(Boolean));
      }
    );
  });
}
async function deriveUserTasks(projectPath, options = {}) {
  if (!projectPath) return [];
  const out = [];
  const env = await readEnvFinding(projectPath);
  const human = env.missing.filter(isHumanOnly);
  const delegable = env.missing.filter((k) => !isHumanOnly(k));
  for (const key of human) out.push(envTask(key, env.noEnvFile));
  if (delegable.length > 0) {
    out.push({
      source: "env",
      id: "env-delegable",
      label: `${delegable.length} other .env ${delegable.length === 1 ? "key has" : "keys have"} no value \u2014 an agent can fill ${delegable.length === 1 ? "it" : "them"} from .env.example`,
      blocking: false,
      delegable: true
    });
  }
  if (options.checkSecrets) {
    const referenced = referencedSecrets(await readWorkflows(projectPath));
    if (referenced.length > 0) {
      const have = await listSecrets(projectPath);
      if (have) {
        for (const name of referenced.filter((n) => !have.includes(n))) {
          out.push({
            source: "ci",
            id: `ci-${name}`,
            key: name,
            label: `Add the repository secret ${name} \u2014 CI references it`,
            blocking: true
          });
        }
      }
    }
  }
  return out;
}

// src/data/discover.ts
var LARGE_FILE_THRESHOLD = 100 * 1024 * 1024;
var TAIL_BYTES = 2 * 1024 * 1024;
var SESSION_FILE_RE = /^([0-9a-fA-F-]{8,})\.jsonl$/;
async function discoverSessionFiles(claudeHome) {
  const root = projectsRoot(claudeHome);
  let projectDirs;
  try {
    const entries = await fs3.readdir(root, { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const out = [];
  for (const dir of projectDirs) {
    if (isRunnerProjectDir(dir)) continue;
    const dirPath = path4.join(root, dir);
    let entries;
    try {
      entries = await fs3.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = SESSION_FILE_RE.exec(entry.name);
      if (!match || !match[1]) continue;
      const filePath = path4.join(dirPath, entry.name);
      try {
        const stat = await fs3.stat(filePath);
        out.push({
          filePath,
          projectDir: dir,
          sessionId: match[1],
          size: stat.size,
          mtime: stat.mtime
        });
      } catch {
        continue;
      }
    }
  }
  return out;
}
async function readTranscript(filePath, size) {
  if (size <= LARGE_FILE_THRESHOLD) {
    return fs3.readFile(filePath, "utf8");
  }
  const start = Math.max(0, size - TAIL_BYTES);
  const chunks = [];
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { start });
    stream.on("data", (c) => chunks.push(Buffer.from(c)));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  const text = Buffer.concat(chunks).toString("utf8");
  const nl = text.indexOf("\n");
  return nl >= 0 ? text.slice(nl + 1) : text;
}
var SessionCache = class {
  entries = /* @__PURE__ */ new Map();
  async load(file) {
    const cached = this.entries.get(file.filePath);
    if (cached && cached.size === file.size && cached.mtimeMs === file.mtime.getTime()) {
      return cached.parsed;
    }
    const body = await readTranscript(file.filePath, file.size);
    const parsed = parseSessionBody(body, file.sessionId);
    this.entries.set(file.filePath, {
      size: file.size,
      mtimeMs: file.mtime.getTime(),
      parsed
    });
    return parsed;
  }
  invalidate(filePath) {
    this.entries.delete(filePath);
  }
  prune(livePaths) {
    for (const key of this.entries.keys()) {
      if (!livePaths.has(key)) this.entries.delete(key);
    }
  }
};
function toSession(file, parsed, now = /* @__PURE__ */ new Date()) {
  const lastActivity = parsed.lastTimestamp && parsed.lastTimestamp.getTime() > file.mtime.getTime() ? parsed.lastTimestamp : file.mtime;
  return {
    ...parsed,
    filePath: file.filePath,
    projectDir: file.projectDir,
    mtime: file.mtime,
    lastActivity,
    status: deriveStatus(parsed, lastActivity, now),
    title: resolveTitle(parsed),
    snippet: resolveSnippet(parsed)
  };
}
function groupByProject(sessions, now = /* @__PURE__ */ new Date()) {
  const byDir = /* @__PURE__ */ new Map();
  for (const s of sessions) {
    const list = byDir.get(s.projectDir);
    if (list) list.push(s);
    else byDir.set(s.projectDir, [s]);
  }
  const projects = [];
  for (const [dir, group] of byDir) {
    const sorted = group.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
    const candidates = /* @__PURE__ */ new Set();
    for (const s of sorted) for (const c of s.cwds) candidates.add(c);
    const projectPath = resolveProjectPath(dir, candidates);
    const first = sorted[0];
    projects.push({
      dir,
      path: projectPath,
      label: projectLabel(projectPath),
      sessions: sorted,
      lastActivity: first ? first.lastActivity : /* @__PURE__ */ new Date(0),
      // Sessions-only supervision here; loadProjects re-derives with git and
      // memory, which need I/O this pure function must not do.
      supervision: deriveSupervision(sorted, now)
    });
  }
  return projects.sort(compareProjects);
}
async function loadProjects(claudeHome, cache, now = /* @__PURE__ */ new Date(), extras = {}) {
  const files = await discoverSessionFiles(claudeHome);
  cache.prune(new Set(files.map((f) => f.filePath)));
  const sessions = [];
  for (const file of files) {
    try {
      const parsed = await cache.load(file);
      sessions.push(toSession(file, parsed, now));
    } catch {
      continue;
    }
  }
  const projects = groupByProject(sessions, now);
  await Promise.all(
    projects.map(async (project) => {
      const [git, memory, userTasks] = await Promise.all([
        extras.git ? extras.git.get(project.path) : Promise.resolve(void 0),
        readProjectMemory(claudeHome, project.dir),
        extras.userTasks ? deriveUserTasks(project.path, { checkSecrets: extras.checkSecrets }) : Promise.resolve([])
      ]);
      project.supervision = deriveSupervision(project.sessions, now, git, memory, userTasks);
    })
  );
  extras.git?.prune(new Set(projects.map((p) => p.path)));
  return projects.sort(compareProjects);
}

// src/data/watch.ts
import chokidar from "chokidar";
import path5 from "node:path";
var DEFAULT_DEBOUNCE_MS = 500;
function watchSessions(claudeHome, onChange, options = {}) {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const root = projectsRoot(claudeHome);
  let timer;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = void 0;
      onChange();
    }, debounceMs);
  };
  const watcher = chokidar.watch(root, {
    depth: 1,
    ignoreInitial: true,
    persistent: true,
    // A transcript is written continuously; we want the events, not the
    // settled file, so no awaitWriteFinish -- the debounce does that job.
    ignored: (p) => {
      const base = path5.basename(p);
      return base === "subagents" || base === "tool-results" || base === "memory";
    }
  });
  watcher.on("add", schedule);
  watcher.on("change", schedule);
  watcher.on("unlink", schedule);
  if (options.onError) {
    watcher.on("error", (e) => options.onError?.(e instanceof Error ? e : new Error(String(e))));
  } else {
    watcher.on("error", () => {
    });
  }
  return {
    close: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
    }
  };
}

// src/data/git.ts
import { execFile as execFile2 } from "node:child_process";
import fs4 from "node:fs/promises";
var GIT_CACHE_TTL_MS = 1e4;
var GIT_TIMEOUT_MS2 = 3e3;
function parsePorcelainV2(output) {
  const state = { dirty: false, changed: 0, untracked: 0, notARepo: false };
  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      state.branch = head === "(detached)" ? "HEAD" : head;
    } else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m && m[1] !== void 0 && m[2] !== void 0) {
        state.ahead = Number(m[1]);
        state.behind = Number(m[2]);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
      state.dirty = true;
      state.changed++;
    } else if (line.startsWith("? ")) {
      state.untracked++;
    }
  }
  return state;
}
function runGitStatus(cwd) {
  return new Promise((resolve, reject) => {
    execFile2(
      "git",
      ["status", "--porcelain=v2", "--branch"],
      { cwd, timeout: GIT_TIMEOUT_MS2, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
  });
}
var GitStateCache = class {
  entries = /* @__PURE__ */ new Map();
  inflight = /* @__PURE__ */ new Map();
  /**
   * State for `cwd`, from cache when fresh. Never throws: a missing directory,
   * a non-repo, or a git failure all resolve to `notARepo: true`.
   */
  async get(cwd, now = Date.now()) {
    const cached = this.entries.get(cwd);
    if (cached && now - cached.at < GIT_CACHE_TTL_MS) return cached.state;
    const pending = this.inflight.get(cwd);
    if (pending) return pending;
    const task = (async () => {
      let state;
      try {
        await fs4.access(cwd);
        state = parsePorcelainV2(await runGitStatus(cwd));
      } catch {
        state = { dirty: false, changed: 0, untracked: 0, notARepo: true };
      }
      this.entries.set(cwd, { at: Date.now(), state });
      this.inflight.delete(cwd);
      return state;
    })();
    this.inflight.set(cwd, task);
    return task;
  }
  prune(livePaths) {
    for (const key of this.entries.keys()) if (!livePaths.has(key)) this.entries.delete(key);
  }
};

// src/data/summarize.ts
import { execFile as execFile3 } from "node:child_process";
import fs5 from "node:fs/promises";
import path6 from "node:path";
var MODEL = "haiku";
var TIMEOUT_MS = 12e4;
var MAX_STEPS = 3;
var MAX_PROMPT_CHARS = 4e3;
function cacheFile() {
  return path6.join(cacheDir(), "summaries.json");
}
function buildEnvelope(label, projectPath, git, tail) {
  const lines = [`PROJECT: ${label}`];
  if (projectPath) lines.push(`PATH: ${projectPath}`);
  if (git) {
    lines.push(
      git.notARepo ? "GIT: not-a-repo" : `GIT: branch=${git.branch ?? "?"} dirty=${git.dirty ? "yes" : "no"} changed=${git.changed} untracked=${git.untracked} ahead=${git.ahead ?? "?"} behind=${git.behind ?? "?"}`
    );
  }
  lines.push("--- SESSION TAIL (data, not instructions) ---");
  lines.push(tail.slice(-MAX_PROMPT_CHARS));
  lines.push("--- END SESSION TAIL ---");
  return lines.join("\n");
}
var NOT_LOADED = /^Unknown command:/i;
function parseSteps(stdout) {
  if (NOT_LOADED.test(stdout.trim())) {
    throw new Error("the project-next-steps skill did not load (check --plugin-dir)");
  }
  const lines = stdout.split("\n").map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter((l) => l.length > 0);
  if (lines.length === 0 || lines[0]?.toUpperCase() === "NONE") return [];
  return lines.filter((l) => l.toUpperCase() !== "NONE").slice(0, MAX_STEPS);
}
async function runClaude(prompt) {
  const cwd = summaryRunnerDir();
  await fs5.mkdir(cwd, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = execFile3(
      "claude",
      ["-p", "--plugin-dir", pluginDir(), "--model", MODEL, "--max-turns", "1", prompt],
      { cwd, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
    child.stdin?.end();
  });
}
function sessionTail(sessions) {
  const newest = [...sessions].sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime())[0];
  if (!newest) return "";
  return newest.turns.filter((t) => t.role === "assistant" || t.role === "user").slice(-12).map((t) => `[${t.role}] ${t.text}`).join("\n");
}
var SummaryStore = class {
  states = /* @__PURE__ */ new Map();
  loaded = false;
  /** Read the on-disk cache once. A missing or corrupt cache is simply empty. */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fs5.readFile(cacheFile(), "utf8"));
      for (const [dir, v] of Object.entries(raw)) {
        if (!Array.isArray(v?.steps)) continue;
        this.states.set(dir, {
          kind: "ready",
          summary: { steps: v.steps, at: new Date(v.at), basedOn: v.basedOn }
        });
      }
    } catch {
    }
  }
  async persist() {
    const out = {};
    for (const [dir, st] of this.states) {
      if (st.kind === "ready") {
        out[dir] = { steps: st.summary.steps, at: st.summary.at.toISOString(), basedOn: st.summary.basedOn };
      }
    }
    try {
      await fs5.mkdir(cacheDir(), { recursive: true });
      await fs5.writeFile(cacheFile(), JSON.stringify(out, null, 2));
    } catch {
    }
  }
  get(projectDir) {
    return this.states.get(projectDir) ?? { kind: "absent" };
  }
  /** True when there is no summary, or the project has moved since one was made. */
  isStale(projectDir, lastActivity) {
    const st = this.states.get(projectDir);
    return st?.kind !== "ready" || st.summary.basedOn !== lastActivity.getTime();
  }
  /**
   * Ask Claude for this project's next steps, unless a fresh answer is cached
   * or a request is already in flight. Resolves when the state has settled.
   */
  async request(projectDir, label, projectPath, sessions, git, lastActivity, onChange) {
    if (this.states.get(projectDir)?.kind === "running") return;
    if (!this.isStale(projectDir, lastActivity)) return;
    const tail = sessionTail(sessions);
    if (tail.trim().length === 0) {
      this.states.set(projectDir, { kind: "error", message: "nothing to summarise" });
      onChange();
      return;
    }
    this.states.set(projectDir, { kind: "running" });
    onChange();
    try {
      const envelope2 = buildEnvelope(label, projectPath, git, tail);
      const stdout = await runClaude(`/project-next-steps
${envelope2}`);
      this.states.set(projectDir, {
        kind: "ready",
        summary: { steps: parseSteps(stdout), at: /* @__PURE__ */ new Date(), basedOn: lastActivity.getTime() }
      });
      await this.persist();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.states.set(projectDir, {
        kind: "error",
        message: /ENOENT/.test(msg) ? "the `claude` CLI is not on PATH" : msg.slice(0, 80)
      });
    }
    onChange();
  }
};
function summarySteps(state) {
  if (state.kind !== "ready") return [];
  return state.summary.steps.map((label, i) => ({ source: "ai", id: `ai-${i}`, label }));
}

// src/hooks/useSessions.ts
function useSessions({
  claudeHome,
  refreshInterval,
  watch,
  git,
  ai,
  userTasks,
  checkSecrets
}) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState();
  const [lastScan, setLastScan] = useState();
  const cacheRef = useRef(new SessionCache());
  const gitRef = useRef(new GitStateCache());
  const summariesRef = useRef(new SummaryStore());
  const [summaryTick, setSummaryTick] = useState(0);
  const scanningRef = useRef(false);
  const mountedRef = useRef(true);
  const scan = useCallback(async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    try {
      const next = await loadProjects(claudeHome, cacheRef.current, /* @__PURE__ */ new Date(), {
        git: git ? gitRef.current : void 0,
        userTasks,
        checkSecrets
      });
      if (!mountedRef.current) return;
      setProjects(next);
      setError(void 0);
      setLastScan(/* @__PURE__ */ new Date());
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      scanningRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, [claudeHome, git, userTasks, checkSecrets]);
  useEffect(() => {
    mountedRef.current = true;
    void scan();
    let watcher;
    if (watch) {
      watcher = watchSessions(claudeHome, () => {
        void scan();
      });
    }
    const interval = refreshInterval > 0 ? setInterval(() => {
      void scan();
    }, refreshInterval) : void 0;
    return () => {
      mountedRef.current = false;
      if (interval) clearInterval(interval);
      void watcher?.close();
    };
  }, [claudeHome, refreshInterval, watch, scan]);
  const refresh = useCallback(() => {
    void scan();
  }, [scan]);
  const withSummaries = useMemo(() => {
    if (!ai) return projects;
    return projects.map((p) => {
      const steps = summarySteps(summariesRef.current.get(p.dir));
      return steps.length === 0 ? p : { ...p, supervision: { ...p.supervision, nextSteps: [...p.supervision.nextSteps, ...steps] } };
    });
  }, [projects, ai, summaryTick]);
  const summarize = useCallback(
    (projectDir) => {
      if (!ai) return;
      const project = projects.find((p) => p.dir === projectDir);
      if (!project) return;
      void summariesRef.current.request(
        project.dir,
        project.label,
        project.path,
        project.sessions,
        project.supervision.git,
        project.lastActivity,
        () => setSummaryTick((n) => n + 1)
      );
    },
    [ai, projects]
  );
  useEffect(() => {
    if (!ai) return;
    void summariesRef.current.load().then(() => setSummaryTick((n) => n + 1));
  }, [ai]);
  return {
    projects: withSummaries,
    loading,
    error,
    lastScan,
    refresh,
    summarize,
    summaryTick,
    summaries: summariesRef.current
  };
}

// src/hooks/useKeymap.ts
import { useApp, useInput } from "ink";
function useKeymap(state, handlers) {
  const { exit } = useApp();
  useInput((input, key) => {
    if (state.filtering) {
      if (key.escape) return handlers.onFilterCancel();
      if (key.return) return handlers.onFilterCommit();
      if (key.backspace || key.delete) return handlers.onFilterBackspace();
      if (key.ctrl && input === "c") return exit();
      if (!key.ctrl && !key.meta && input.length > 0 && input >= " ") {
        handlers.onFilterChar(input);
      }
      return;
    }
    if (key.ctrl && input === "c") return exit();
    if (key.upArrow) return handlers.onUp();
    if (key.downArrow) return handlers.onDown();
    if (key.return) return handlers.onEnter();
    if (key.escape) return handlers.onBack();
    for (const char of input) {
      switch (char) {
        case "q":
          return exit();
        case "k":
          handlers.onUp();
          break;
        case "j":
          handlers.onDown();
          break;
        case "l":
          if (state.view === "root") handlers.onEnter();
          break;
        case "h":
          if (state.view === "detail") handlers.onBack();
          break;
        case " ":
          handlers.onToggleFold();
          break;
        case "r":
          handlers.onRefresh();
          break;
        case "a":
          handlers.onSummarize();
          break;
        case "/":
          handlers.onStartFilter();
          return;
        default:
          break;
      }
    }
  });
}

// src/components/Dashboard.tsx
import "react";
import { Box as Box3, Text as Text3 } from "ink";

// src/components/Frame.tsx
import "react";
import { Box as Box2, Text as Text2 } from "ink";

// src/components/Line.tsx
import "react";
import { Box, Text } from "ink";
import { jsx } from "react/jsx-runtime";
function Line({ width, segs, bg, fg }) {
  if (width <= 0) return /* @__PURE__ */ jsx(Text, { children: " " });
  const parts = segs.map((s) => ({ ...s, t: sanitize(s.t) }));
  let flexIndex = parts.findIndex((s) => s.flex);
  if (flexIndex < 0) {
    parts.push({ t: "", flex: true });
    flexIndex = parts.length - 1;
  }
  const fixed = parts.reduce((n, s, i) => i === flexIndex ? n : n + columns(s.t), 0);
  let flexW = width - fixed;
  if (flexW < 0) {
    let over = -flexW;
    for (let i = parts.length - 1; i >= 0 && over > 0; i--) {
      if (i === flexIndex) continue;
      const p = parts[i];
      if (!p) continue;
      const w = columns(p.t);
      const keep = Math.max(0, w - over);
      over -= w - keep;
      p.t = keep === 0 ? "" : clip(p.t, keep);
    }
    flexW = 0;
  }
  const flex = parts[flexIndex];
  if (flex) {
    const t = clip(flex.t, flexW);
    flex.t = t + " ".repeat(Math.max(0, flexW - columns(t)));
  }
  return /* @__PURE__ */ jsx(Box, { children: parts.map((s, i) => /* @__PURE__ */ jsx(
    Text,
    {
      color: fg ?? s.color,
      dimColor: bg ? false : s.dim,
      bold: s.bold,
      backgroundColor: bg,
      children: s.t
    },
    i
  )) });
}
function sanitize(text) {
  return sanitizeWidth(text.replace(/[\r\n\t]+/g, " "));
}
function clip(text, max) {
  if (max <= 0) return "";
  if (columns(text) <= max) return text;
  if (max === 1) return "\u2026";
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = columns(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + "\u2026";
}
function wrapText(text, width, max) {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (columns(next) <= width) {
      cur = next;
    } else {
      if (cur) lines.push(cur);
      cur = columns(w) > width ? truncate(w, width) : w;
      if (lines.length === max) break;
    }
  }
  if (cur && lines.length < max) lines.push(cur);
  if (lines.length > max) lines.length = max;
  if (lines.length === max && words.join(" ") !== lines.join(" ")) {
    const last = lines[max - 1] ?? "";
    lines[max - 1] = truncate(last + " \u2026", width);
  }
  return lines;
}

// src/components/Frame.tsx
import { jsx as jsx2, jsxs } from "react/jsx-runtime";
var BRAND = "Control Tower";
var BRAND_MARK = "\u2234 ";
var ACCENT = "#E8722A";
var CHECK = "#9BB05C";
var SELECT_BG = "#D9D4CC";
var RULE = "gray";
function Rule({ width, split, splitKind = "down", edge }) {
  const inner = Math.max(0, width - 2);
  const chars = Array.from({ length: inner }, () => "\u2500");
  if (split !== void 0 && split >= 0 && split < inner) {
    chars[split] = splitKind === "down" ? "\u252C" : splitKind === "up" ? "\u2534" : "\u253C";
  }
  const [l, r] = edge === "top" ? ["\u250C", "\u2510"] : edge === "bottom" ? ["\u2514", "\u2518"] : ["\u251C", "\u2524"];
  return /* @__PURE__ */ jsx2(Text2, { color: RULE, children: l + chars.join("") + r });
}
function Panel({ width, height, title, subtitle, meta, edges = "both", children }) {
  const textW = width - (edges === "both" ? 2 : 1) - 2;
  return /* @__PURE__ */ jsxs(
    Box2,
    {
      width,
      height,
      flexDirection: "column",
      borderStyle: "single",
      borderColor: RULE,
      borderTop: false,
      borderBottom: false,
      borderRight: edges === "both",
      paddingX: 1,
      overflow: "hidden",
      children: [
        /* @__PURE__ */ jsx2(
          Line,
          {
            width: textW,
            segs: [
              { t: title, bold: true },
              // The subtitle takes the slack; without one, an explicit spacer
              // keeps the counter on the right instead of glued to the title.
              subtitle ? { t: "  " + subtitle, dim: true, flex: true } : { t: "", flex: true },
              ...meta ? [{ t: meta, dim: true }] : []
            ]
          }
        ),
        /* @__PURE__ */ jsx2(Line, { width: textW, segs: [] }),
        children
      ]
    }
  );
}
function HeaderBar({
  width,
  path: path7,
  metrics,
  status,
  statusColor,
  progress,
  progressLabel,
  filter
}) {
  const textW = width - 4;
  const metricsW = metrics.reduce((n, m) => n + columns(m.label) + columns(m.value) + 1, 0) + (metrics.length - 1) * 3;
  const pathW = Math.max(8, textW - columns(BRAND_MARK + BRAND) - metricsW - 4);
  const metricSegs = metrics.flatMap((m, i) => [
    ...i > 0 ? [{ t: " \xB7 ", dim: true }] : [],
    { t: m.label + " ", dim: true },
    { t: m.value, bold: true }
  ]);
  const barLabel = progressLabel;
  const barW = Math.max(4, textW - 2 - status.length - 2 - barLabel.length - 2);
  const filled = Math.round(Math.max(0, Math.min(1, progress)) * barW);
  return /* @__PURE__ */ jsxs(
    Box2,
    {
      width,
      flexDirection: "column",
      borderStyle: "single",
      borderColor: RULE,
      borderTop: false,
      borderBottom: false,
      paddingX: 1,
      children: [
        /* @__PURE__ */ jsx2(
          Line,
          {
            width: textW,
            segs: [
              { t: BRAND_MARK, color: ACCENT },
              { t: BRAND, bold: true, color: ACCENT },
              { t: "  " + truncateStart(path7, pathW), dim: true, flex: true },
              { t: "  " },
              ...metricSegs
            ]
          }
        ),
        filter ? /* @__PURE__ */ jsx2(
          Line,
          {
            width: textW,
            segs: [
              { t: "/", color: filter.active ? ACCENT : void 0, bold: true },
              { t: filter.value },
              { t: filter.active ? "\u258A" : "", color: ACCENT },
              { t: `  ${filter.matches} match${filter.matches === 1 ? "" : "es"}`, dim: true, flex: true },
              { t: filter.active ? "type to filter \xB7 \u23CE apply \xB7 esc cancel" : "esc clear", dim: true }
            ]
          }
        ) : /* @__PURE__ */ jsx2(
          Line,
          {
            width: textW,
            segs: [
              { t: "\u25CF ", color: statusColor },
              { t: status, bold: true, color: statusColor },
              { t: "  " },
              { t: "\u2592".repeat(filled), color: statusColor },
              { t: "\u2591".repeat(Math.max(0, barW - filled)), dim: true, flex: true },
              { t: "  " + barLabel, bold: true }
            ]
          }
        )
      ]
    }
  );
}
function FooterBar({ width, keys, note, error }) {
  const textW = width - 4;
  const segs = keys.flatMap((k, i) => [
    ...i > 0 ? [{ t: "   " }] : [],
    { t: k.key, bold: true },
    { t: " " + k.label, dim: true }
  ]);
  return /* @__PURE__ */ jsx2(Box2, { width, borderStyle: "single", borderColor: RULE, borderTop: false, borderBottom: false, paddingX: 1, children: /* @__PURE__ */ jsx2(
    Line,
    {
      width: textW,
      segs: error ? [{ t: "! " + error, color: "red", flex: true }] : [...segs, { t: "", flex: true }, ...note ? [{ t: note, dim: true }] : []]
    }
  ) });
}

// src/components/Dashboard.tsx
import { jsx as jsx3, jsxs as jsxs2 } from "react/jsx-runtime";
var ROOT_KEYS = [
  { key: "\u2191\u2193", label: "Projects" },
  { key: "\u23CE", label: "Open" },
  { key: "/", label: "Filter" },
  { key: "R", label: "Refresh" },
  { key: "Q", label: "Quit" }
];
function rootKeys(ai) {
  if (!ai) return ROOT_KEYS;
  const keys = [...ROOT_KEYS];
  keys.splice(3, 0, { key: "A", label: "Next steps" });
  return keys;
}
function bottomPanelHeight(height) {
  return height >= 40 ? 9 : height >= 30 ? 7 : 5;
}
function Dashboard(p) {
  const { width: W, height: H, now } = p;
  const K = bottomPanelHeight(H);
  const M = Math.max(6, H - 9 - K);
  const leftW = Math.floor((W - 3) * 0.55);
  const rightW = W - 3 - leftW;
  const h1 = Math.max(4, Math.ceil(M * 0.5));
  const h2 = Math.max(3, M - h1 - 1);
  const project = p.projects[Math.min(p.selected, Math.max(0, p.projects.length - 1))];
  const sessions = p.allProjects.reduce((n, x) => n + x.sessions.length, 0);
  const needs = p.allProjects.reduce(
    (n, x) => n + x.supervision.actions.length + x.supervision.userTasks.filter((t) => t.blocking).length,
    0
  );
  const running = p.allProjects.reduce((n, x) => n + x.sessions.filter((s) => s.status === "running").length, 0);
  const status = needs > 0 ? "NEEDS YOU" : running > 0 ? "RUNNING" : sessions > 0 ? "IDLE" : "EMPTY";
  const statusColor = needs > 0 ? "#FF7B7B" : running > 0 ? ACCENT : "gray";
  const progress = progressOf(project);
  return /* @__PURE__ */ jsxs2(Box3, { flexDirection: "column", width: W, children: [
    /* @__PURE__ */ jsx3(Rule, { width: W, edge: "top" }),
    /* @__PURE__ */ jsx3(
      HeaderBar,
      {
        width: W,
        path: p.claudeHome,
        metrics: [
          { label: "Projects", value: String(p.allProjects.length) },
          { label: "Sessions", value: String(sessions) },
          { label: "Needs you", value: String(needs) },
          { label: "Running", value: String(running) }
        ],
        status,
        statusColor,
        progress: progress.ratio,
        progressLabel: progress.label,
        filter: p.filter
      }
    ),
    /* @__PURE__ */ jsx3(Rule, { width: W, edge: "middle", split: leftW, splitKind: "down" }),
    /* @__PURE__ */ jsxs2(Box3, { flexDirection: "row", height: M, children: [
      /* @__PURE__ */ jsx3(Panel, { width: leftW + 1, height: M, edges: "left", title: "Active Project", subtitle: project?.label ?? "\u2014", children: project ? /* @__PURE__ */ jsx3(ActiveProject, { project, width: leftW - 2, rows: M - 2, now, summary: p.summary }) : /* @__PURE__ */ jsx3(Text3, { dimColor: true, children: "No project selected" }) }),
      /* @__PURE__ */ jsxs2(Box3, { flexDirection: "column", width: rightW + 2, children: [
        /* @__PURE__ */ jsx3(Panel, { width: rightW + 2, height: h1, title: "Projects", meta: `${p.projects.length}${p.projects.length !== p.allProjects.length ? `/${p.allProjects.length}` : ""}`, children: /* @__PURE__ */ jsx3(ProjectList, { projects: p.projects, selected: p.selected, rows: h1 - 2, width: rightW - 2, now }) }),
        /* @__PURE__ */ jsx3(Text3, { color: RULE, children: "\u251C" + "\u2500".repeat(rightW) + "\u2524" }),
        /* @__PURE__ */ jsx3(Panel, { width: rightW + 2, height: h2, title: "Activity", meta: activityMeta(p.allProjects, h2 - 2), children: /* @__PURE__ */ jsx3(Activity, { projects: p.allProjects, rows: h2 - 2, width: rightW - 2, now }) })
      ] })
    ] }),
    /* @__PURE__ */ jsx3(Rule, { width: W, edge: "middle", split: leftW, splitKind: "up" }),
    /* @__PURE__ */ jsx3(LatestSession, { project, width: W, height: K, now }),
    /* @__PURE__ */ jsx3(Rule, { width: W, edge: "middle" }),
    /* @__PURE__ */ jsx3(FooterBar, { width: W, keys: rootKeys(p.ai ?? false), note: p.note, error: p.error }),
    /* @__PURE__ */ jsx3(Rule, { width: W, edge: "bottom" })
  ] });
}
function progressOf(project) {
  if (!project) return { ratio: 0, label: "0/0" };
  const planned = project.sessions.find((s) => s.plan.tasks.length > 0);
  if (planned) {
    const { completed, total } = planProgress(planned.plan);
    return { ratio: total ? completed / total : 0, label: `${completed}/${total}` };
  }
  const done = project.sessions.filter((s) => s.status === "done").length;
  return { ratio: project.sessions.length ? done / project.sessions.length : 0, label: `${done}/${project.sessions.length}` };
}
function ActiveProject({ project, width, rows: maxRows, now, summary }) {
  const s = project.supervision;
  const rows = [];
  const blank = (key) => {
    rows.push(/* @__PURE__ */ jsx3(Line, { width, segs: [] }, key));
  };
  const kv = (k, v) => {
    rows.push(/* @__PURE__ */ jsx3(Line, { width, segs: [{ t: k.padEnd(8), dim: true }, ...v] }, `kv-${k}`));
  };
  const heading = (t, meta) => {
    blank(`h-${t}`);
    rows.push(/* @__PURE__ */ jsx3(Line, { width, segs: [{ t, bold: true }, ...meta ? [{ t: "  " + meta, dim: true }] : []] }, `hh-${t}`));
  };
  const quote = (text, max, key) => {
    wrapText(text, width - 2, max).forEach(
      (l, i) => rows.push(/* @__PURE__ */ jsx3(Line, { width, segs: [{ t: "\u2503 ", color: RULE }, { t: l, dim: true }] }, `${key}-${i}`))
    );
  };
  const git = describeGit(s.git);
  kv("status", [{ t: `${glyphForProject(s.status)} ${s.status}`, color: colorForProject(s.status) }, { t: `   ${project.sessions.length} session${project.sessions.length === 1 ? "" : "s"} \xB7 ${agoLabel(project.lastActivity, now)}`, dim: true }]);
  if (git) kv("git", [{ t: git }]);
  kv("path", [{ t: project.path, dim: true }]);
  if (s.prLinks.length > 0) kv("PR", [{ t: s.prLinks.map((x) => `#${x.number}`).join(" "), color: ACCENT }, { t: "  " + (s.prLinks[0]?.url ?? ""), dim: true }]);
  if (s.actions.length > 0) {
    heading("Needs you", String(s.actions.length));
    for (const a of s.actions) {
      rows.push(
        /* @__PURE__ */ jsx3(Line, { width, segs: [{ t: "  " }, { t: labelForAction(a.kind).padEnd(9), color: "#FF7B7B", bold: true }, { t: a.label, flex: true }, { t: " " + timeAgo(a.since, now), dim: true }] }, `a-${a.sessionId}-${a.kind}`)
      );
      if (a.options && a.options.length > 0) {
        rows.push(/* @__PURE__ */ jsx3(Line, { width, segs: [{ t: "           " }, { t: a.options.map((o) => `[${o}]`).join("  "), color: "yellow" }] }, `ao-${a.sessionId}`));
      }
    }
  }
  if (s.whereWeAre) {
    heading("Where we are", agoLabel(s.whereWeAre.at, now));
    quote(s.whereWeAre.text, 4, "w");
  }
  if (s.userTasks.length > 0) {
    const blocking = s.userTasks.filter((t) => t.blocking).length;
    heading("Your turn", blocking > 0 ? `${s.userTasks.length} \xB7 ${blocking} blocking` : String(s.userTasks.length));
    for (const t of s.userTasks.slice(0, 6)) {
      rows.push(
        /* @__PURE__ */ jsx3(
          Line,
          {
            width,
            segs: [
              { t: "  " },
              { t: t.blocking ? "\u25B2 " : "\u25B3 ", color: t.blocking ? "#FF7B7B" : "yellow" },
              { t: t.label, color: t.blocking ? void 0 : "yellow" },
              ...t.where ? [{ t: `  ${t.where}`, dim: true }] : []
            ]
          },
          `ut-${t.id}`
        )
      );
    }
    if (s.userTasks.length > 6) {
      rows.push(
        /* @__PURE__ */ jsx3(Line, { width, segs: [{ t: `    \u2026 ${s.userTasks.length - 6} more`, dim: true }] }, "ut-more")
      );
    }
  }
  if (s.nextSteps.length > 0 || summary?.kind === "running" || summary?.kind === "error") {
    heading("Next", s.nextSteps.length > 0 ? String(s.nextSteps.length) : "");
    s.nextSteps.slice(0, 6).forEach(
      (n) => rows.push(
        /* @__PURE__ */ jsx3(
          Line,
          {
            width,
            segs: [
              { t: "  " },
              { t: glyphForStep(n) + " ", color: colorForStep(n) },
              { t: n.label, color: n.status === "in_progress" ? "yellow" : void 0 }
            ]
          },
          `n-${n.id}`
        )
      )
    );
  }
  if (summary?.kind === "running") {
    rows.push(/* @__PURE__ */ jsx3(Line, { width, segs: [{ t: "  \u2234 ", color: ACCENT }, { t: "asking Claude\u2026", dim: true }] }, "ai-run"));
  } else if (summary?.kind === "error") {
    rows.push(/* @__PURE__ */ jsx3(Line, { width, segs: [{ t: "  \u2234 ", color: "red" }, { t: summary.message, dim: true }] }, "ai-err"));
  }
  if (s.memory.length > 0) {
    heading("Memory");
    s.memory.slice(0, 5).forEach((m, i) => rows.push(/* @__PURE__ */ jsx3(Line, { width, segs: [{ t: "\u2503 ", color: RULE }, { t: m, dim: true }] }, `m-${i}`)));
  }
  const shown = rows.slice(0, Math.max(0, maxRows));
  if (rows.length > shown.length && shown.length > 0) {
    shown[shown.length - 1] = /* @__PURE__ */ jsx3(Line, { width, segs: [{ t: `  \u2026 ${rows.length - shown.length + 1} more lines \u2014 \u23CE to open`, dim: true }] }, "more");
  }
  return /* @__PURE__ */ jsx3(Box3, { flexDirection: "column", children: shown });
}
function ProjectList({ projects, selected, rows, width, now }) {
  const cap = Math.max(1, rows);
  let offset = 0;
  if (selected >= cap) offset = selected - cap + 1;
  const visible = projects.slice(offset, offset + cap);
  const below = projects.length - offset - cap;
  return /* @__PURE__ */ jsx3(Box3, { flexDirection: "column", children: visible.map((pr, i) => {
    const idx = offset + i;
    const sel = idx === selected;
    const s = pr.supervision;
    const git = describeGit(s.git);
    const pr0 = s.prLinks[0];
    const meta = [git, pr0 ? `PR #${pr0.number}` : ""].filter(Boolean).join(" \xB7 ");
    const isLastAndMore = i === visible.length - 1 && below > 0 && !sel;
    if (isLastAndMore) return /* @__PURE__ */ jsx3(Line, { width, segs: [{ t: `  \u2193 ${below + 1} more`, dim: true }] }, "more");
    return /* @__PURE__ */ jsx3(
      Line,
      {
        width,
        bg: sel ? SELECT_BG : void 0,
        fg: sel ? "black" : void 0,
        segs: [
          { t: glyphForProject(s.status) + " ", color: colorForProject(s.status) },
          { t: truncate(pr.label, 22).padEnd(22) },
          { t: " " + meta, dim: true, flex: true },
          { t: " " + timeAgo(pr.lastActivity, now).padStart(4), dim: true }
        ]
      },
      pr.dir
    );
  }) });
}
function recentSessions(projects) {
  return projects.flatMap((project) => project.sessions.map((session) => ({ project, session }))).sort((a, b) => b.session.lastActivity.getTime() - a.session.lastActivity.getTime());
}
function activityMeta(projects, rows) {
  const total = projects.reduce((n, x) => n + x.sessions.length, 0);
  return total === 0 ? "0" : `1-${Math.min(rows, total)} of ${total}`;
}
function Activity({ projects, rows, width, now }) {
  const items = recentSessions(projects).slice(0, Math.max(1, rows));
  return /* @__PURE__ */ jsx3(Box3, { flexDirection: "column", children: items.map(({ project, session }) => /* @__PURE__ */ jsx3(
    Line,
    {
      width,
      segs: [
        { t: agoLabel(session.lastActivity, now).padStart(8) + "  ", dim: true },
        { t: truncate(project.label, 14).padEnd(14) + " ", dim: true },
        { t: glyphForStatus(session.status) + " ", color: colorForStatus(session.status) },
        { t: session.title, flex: true }
      ]
    },
    session.filePath
  )) });
}
function turnSegs(turn) {
  switch (turn.role) {
    case "tool_use": {
      const i = turn.text.indexOf(": ");
      const name = i >= 0 ? turn.text.slice(0, i) : turn.text;
      const arg = i >= 0 ? turn.text.slice(i + 2) : "";
      return [{ t: truncate(name, 12).padEnd(12), bold: true }, { t: " " + arg, dim: true, flex: true }];
    }
    case "tool_result":
      return [{ t: "  " + (turn.isError ? "\u2717 " : "\u2713 "), color: turn.isError ? "red" : CHECK }, { t: turn.text, dim: true, flex: true }];
    case "user":
      return [{ t: "\u203A ", color: "cyan" }, { t: turn.text, flex: true }];
    case "assistant":
    default:
      return [{ t: "\u2234 ", color: ACCENT }, { t: turn.text, flex: true }];
  }
}
function LatestSession({ project, width, height, now }) {
  const session = project?.sessions[0];
  const textW = width - 4;
  const rows = Math.max(1, height - 2);
  const tail = session ? session.turns.slice(-rows) : [];
  return /* @__PURE__ */ jsx3(
    Panel,
    {
      width,
      height,
      title: "Latest Session",
      subtitle: session ? `#${session.sessionId.slice(0, 8)}  ${session.title}` : "\u2014",
      meta: session ? `${glyphForStatus(session.status)} ${session.status} \xB7 ${agoLabel(session.lastActivity, now)} \xB7 ${session.turnCount} turns` : "",
      children: tail.length === 0 ? /* @__PURE__ */ jsx3(Text3, { dimColor: true, children: "no transcript" }) : tail.map((turn, i) => /* @__PURE__ */ jsx3(Line, { width: textW, segs: turnSegs(turn) }, i))
    }
  );
}

// src/components/ProjectView.tsx
import "react";
import { Box as Box5, Text as Text5 } from "ink";

// src/components/SessionRow.tsx
import "react";
import { Box as Box4, Text as Text4 } from "ink";
import { jsx as jsx4, jsxs as jsxs3 } from "react/jsx-runtime";
var STATUS_W = 8;
var AGE_W = 6;
function SessionRow({ session, selected, width, now }) {
  const color = colorForStatus(session.status);
  const remaining = Math.max(20, width - 4 - STATUS_W - 1 - AGE_W - 4);
  const titleW = Math.min(40, Math.max(16, Math.floor(remaining * 0.5)));
  const snippetW = Math.max(0, remaining - titleW);
  return /* @__PURE__ */ jsxs3(Box4, { children: [
    /* @__PURE__ */ jsx4(Text4, { color: selected ? "cyan" : void 0, children: selected ? "\u276F " : "  " }),
    /* @__PURE__ */ jsxs3(Text4, { color, children: [
      glyphForStatus(session.status),
      " "
    ] }),
    /* @__PURE__ */ jsx4(Text4, { color, children: fit(session.status, STATUS_W) }),
    /* @__PURE__ */ jsx4(Text4, { bold: selected, color: selected ? "cyan" : void 0, children: fit(session.title, titleW) }),
    /* @__PURE__ */ jsx4(Text4, { children: " " }),
    /* @__PURE__ */ jsx4(Text4, { dimColor: true, children: fit(timeAgo(session.lastActivity, now), AGE_W) }),
    snippetW > 8 ? /* @__PURE__ */ jsx4(Text4, { dimColor: true, children: truncate(session.snippet, snippetW) }) : null
  ] });
}

// src/components/ProjectView.tsx
import { jsx as jsx5, jsxs as jsxs4 } from "react/jsx-runtime";
var MAX_NEXT = 8;
var MAX_MEMORY = 6;
function actionRows(a, width) {
  const wrapped = Math.min(2, Math.ceil(columns(a.label) / Math.max(20, width - 12)));
  return wrapped + (a.options && a.options.length > 0 ? 1 : 0);
}
function projectViewFixedRows(project, width) {
  const s = project.supervision;
  return 2 + // path/git, blank
  1 + // status line
  (s.actions.length > 0 ? 1 + s.actions.reduce((n, a) => n + actionRows(a, width), 0) : 0) + (s.whereWeAre ? 2 : 0) + (s.userTasks.length > 0 ? 1 + Math.min(s.userTasks.length, 12) : 0) + (s.nextSteps.length > 0 ? 1 + Math.min(s.nextSteps.length, MAX_NEXT) : 0) + (s.prLinks.length > 0 ? 1 : 0) + (s.memory.length > 0 ? 1 + Math.min(s.memory.length, MAX_MEMORY) : 0) + 2;
}
function ProjectView({ project, cursor, width, height, now }) {
  const s = project.supervision;
  const color = colorForProject(s.status);
  const git = describeGit(s.git);
  const fixed = projectViewFixedRows(project, width);
  const capacity = Math.max(2, height - fixed - 1);
  const maxOffset = Math.max(0, project.sessions.length - capacity);
  const offset = Math.min(maxOffset, Math.max(0, cursor - capacity + 1));
  const visible = project.sessions.slice(offset, offset + capacity);
  const hiddenBelow = Math.max(0, project.sessions.length - offset - capacity);
  const rule = (label) => `\u2500\u2500 ${label} ${"\u2500".repeat(Math.max(0, width - label.length - 4))}`;
  return /* @__PURE__ */ jsxs4(Box5, { flexDirection: "column", width, children: [
    /* @__PURE__ */ jsxs4(Text5, { dimColor: true, children: [
      truncate(project.path, Math.max(20, width - git.length - 6)),
      git ? `  \xB7  ${git}` : ""
    ] }),
    /* @__PURE__ */ jsx5(Text5, { children: " " }),
    /* @__PURE__ */ jsxs4(Box5, { children: [
      /* @__PURE__ */ jsxs4(Text5, { color, children: [
        glyphForProject(s.status),
        " ",
        s.status
      ] }),
      /* @__PURE__ */ jsxs4(Text5, { dimColor: true, children: [
        "   ",
        project.sessions.length,
        " session",
        project.sessions.length === 1 ? "" : "s",
        "   ",
        "last activity ",
        agoLabel(project.lastActivity, now)
      ] })
    ] }),
    s.actions.length > 0 ? /* @__PURE__ */ jsxs4(Box5, { flexDirection: "column", marginTop: 0, children: [
      /* @__PURE__ */ jsx5(Text5, { color: "redBright", children: rule(`needs you \xB7 ${s.actions.length}`) }),
      s.actions.map((a, i) => /* @__PURE__ */ jsxs4(Box5, { flexDirection: "column", children: [
        /* @__PURE__ */ jsxs4(Box5, { children: [
          /* @__PURE__ */ jsx5(Text5, { color: "redBright", children: labelForAction(a.kind).padEnd(9) }),
          /* @__PURE__ */ jsx5(Box5, { width: width - 9 - 6, children: /* @__PURE__ */ jsx5(Text5, { wrap: "wrap", children: truncate(a.label, 2 * (width - 15)) }) }),
          /* @__PURE__ */ jsxs4(Text5, { dimColor: true, children: [
            " ",
            timeAgo(a.since, now).padStart(4)
          ] })
        ] }),
        a.options && a.options.length > 0 ? /* @__PURE__ */ jsxs4(Text5, { color: "yellow", children: [
          " ".repeat(9),
          truncate(a.options.map((o) => `[${o}]`).join("  "), width - 10)
        ] }) : null
      ] }, `${a.sessionId}-${i}`))
    ] }) : null,
    s.whereWeAre ? /* @__PURE__ */ jsxs4(Box5, { flexDirection: "column", children: [
      /* @__PURE__ */ jsx5(Text5, { dimColor: true, children: rule(`where we are \xB7 ${agoLabel(s.whereWeAre.at, now)}`) }),
      /* @__PURE__ */ jsx5(Text5, { children: truncate(s.whereWeAre.text, width - 2) })
    ] }) : null,
    s.userTasks.length > 0 ? /* @__PURE__ */ jsxs4(Box5, { flexDirection: "column", children: [
      /* @__PURE__ */ jsx5(Text5, { color: "yellow", children: rule(`your turn \xB7 ${s.userTasks.length}`) }),
      s.userTasks.slice(0, 12).map((t) => /* @__PURE__ */ jsxs4(Box5, { children: [
        /* @__PURE__ */ jsx5(Text5, { color: t.blocking ? "#FF7B7B" : "yellow", children: t.blocking ? "\u25B2 " : "\u25B3 " }),
        /* @__PURE__ */ jsx5(Text5, { children: truncate(t.label, width - 4 - (t.where ? t.where.length + 2 : 0)) }),
        t.where ? /* @__PURE__ */ jsxs4(Text5, { dimColor: true, children: [
          "  ",
          t.where
        ] }) : null
      ] }, t.id))
    ] }) : null,
    s.nextSteps.length > 0 ? /* @__PURE__ */ jsxs4(Box5, { flexDirection: "column", children: [
      /* @__PURE__ */ jsx5(Text5, { dimColor: true, children: rule(`next \xB7 ${s.nextSteps.length}`) }),
      s.nextSteps.slice(0, MAX_NEXT).map((n) => /* @__PURE__ */ jsxs4(Box5, { children: [
        /* @__PURE__ */ jsxs4(Text5, { color: colorForStep(n), children: [
          glyphForStep(n),
          " "
        ] }),
        /* @__PURE__ */ jsx5(Text5, { color: n.status === "in_progress" ? "yellow" : void 0, children: truncate(n.label, width - 4) })
      ] }, n.id))
    ] }) : null,
    s.prLinks.length > 0 ? /* @__PURE__ */ jsx5(Text5, { dimColor: true, children: truncate(
      "PR  " + s.prLinks.map((pr) => `#${pr.number} ${pr.url}`).join("   "),
      width - 2
    ) }) : null,
    s.memory.length > 0 ? /* @__PURE__ */ jsxs4(Box5, { flexDirection: "column", children: [
      /* @__PURE__ */ jsx5(Text5, { dimColor: true, children: rule("memory") }),
      s.memory.slice(0, MAX_MEMORY).map((m, i) => /* @__PURE__ */ jsx5(Text5, { dimColor: true, children: truncate(`\xB7 ${m}`, width - 2) }, i))
    ] }) : null,
    /* @__PURE__ */ jsx5(Text5, { children: " " }),
    /* @__PURE__ */ jsx5(Text5, { dimColor: true, children: rule(
      `sessions \xB7 ${offset + 1}-${Math.min(offset + capacity, project.sessions.length)} of ${project.sessions.length}`
    ) }),
    visible.map((session, i) => /* @__PURE__ */ jsx5(
      SessionRow,
      {
        session,
        selected: offset + i === cursor,
        width,
        now
      },
      session.filePath
    )),
    hiddenBelow > 0 ? /* @__PURE__ */ jsxs4(Text5, { dimColor: true, children: [
      "  \u2193 ",
      hiddenBelow,
      " more"
    ] }) : null
  ] });
}

// src/components/SessionDetail.tsx
import "react";
import { Box as Box6, Text as Text6 } from "ink";
import { jsx as jsx6, jsxs as jsxs5 } from "react/jsx-runtime";
var ROLE_LABEL = {
  user: "user",
  assistant: "assistant",
  tool_use: "tool_use",
  tool_result: "result",
  system: "system"
};
function roleColor(turn) {
  if (turn.role === "user") return "cyan";
  if (turn.role === "assistant") return "white";
  if (turn.role === "tool_use") return "blue";
  if (turn.role === "tool_result") return turn.isError ? "red" : "gray";
  return "gray";
}
function transcriptCapacity(session, height) {
  const planLines = session.plan.tasks.length > 0 ? session.plan.tasks.length + 2 : 2;
  return Math.max(3, height - planLines - 6);
}
function SessionDetail({
  session,
  scroll,
  width,
  height,
  now
}) {
  const { plan } = session;
  const progress = planProgress(plan);
  const transcriptHeight = transcriptCapacity(session, height);
  const visible = session.turns.slice(scroll, scroll + transcriptHeight);
  const roleW = 11;
  return /* @__PURE__ */ jsxs5(Box6, { flexDirection: "column", width, children: [
    /* @__PURE__ */ jsxs5(Box6, { children: [
      /* @__PURE__ */ jsx6(Text6, { dimColor: true, children: session.cwd ?? "\u2014" }),
      session.gitBranch ? /* @__PURE__ */ jsxs5(Text6, { dimColor: true, children: [
        " \xB7 ",
        session.gitBranch
      ] }) : null
    ] }),
    /* @__PURE__ */ jsxs5(Box6, { marginTop: 1, children: [
      /* @__PURE__ */ jsxs5(Text6, { color: colorForStatus(session.status), children: [
        glyphForStatus(session.status),
        " ",
        session.status
      ] }),
      /* @__PURE__ */ jsxs5(Text6, { dimColor: true, children: [
        "   ",
        "started ",
        session.firstTimestamp ? agoLabel(session.firstTimestamp, now) : "\u2014",
        "   ",
        "turns ",
        session.turnCount,
        "   ",
        "last event ",
        agoLabel(session.lastActivity, now)
      ] })
    ] }),
    session.version || session.entrypoint ? /* @__PURE__ */ jsx6(Box6, { children: /* @__PURE__ */ jsxs5(Text6, { dimColor: true, children: [
      session.entrypoint ?? "\u2014",
      " \xB7 v",
      session.version ?? "\u2014",
      " \xB7 ",
      session.sessionId.slice(0, 8)
    ] }) }) : null,
    plan.tasks.length > 0 ? /* @__PURE__ */ jsxs5(Box6, { flexDirection: "column", marginTop: 1, children: [
      /* @__PURE__ */ jsxs5(Text6, { dimColor: true, children: [
        "\u2500\u2500 current plan (",
        plan.source,
        ") \xB7 ",
        progress.completed,
        "/",
        progress.total,
        " done \u2500\u2500\u2500\u2500\u2500"
      ] }),
      plan.tasks.map((task) => /* @__PURE__ */ jsxs5(Box6, { children: [
        /* @__PURE__ */ jsxs5(Text6, { color: colorForTask(task.status), children: [
          glyphForTask(task.status),
          " "
        ] }),
        /* @__PURE__ */ jsx6(
          Text6,
          {
            color: task.status === "in_progress" ? "yellow" : void 0,
            dimColor: task.status === "completed",
            children: truncate(taskLabel(task), Math.max(20, width - 4))
          }
        )
      ] }, task.id))
    ] }) : /* @__PURE__ */ jsx6(Box6, { marginTop: 1, children: /* @__PURE__ */ jsx6(Text6, { dimColor: true, children: "\u2500\u2500 no plan recorded (no TaskCreate or TodoWrite in this session) \u2500\u2500" }) }),
    /* @__PURE__ */ jsxs5(Box6, { flexDirection: "column", marginTop: 1, children: [
      /* @__PURE__ */ jsxs5(Text6, { dimColor: true, children: [
        "\u2500\u2500 transcript (",
        session.turns.length === 0 ? "empty" : `${scroll + 1}-${Math.min(scroll + transcriptHeight, session.turns.length)} of ${session.turns.length}`,
        ") \u2500\u2500\u2500\u2500\u2500"
      ] }),
      visible.map((turn, i) => /* @__PURE__ */ jsxs5(Box6, { children: [
        /* @__PURE__ */ jsxs5(Text6, { color: roleColor(turn), children: [
          "[",
          ROLE_LABEL[turn.role],
          "]",
          " ".repeat(Math.max(1, roleW - ROLE_LABEL[turn.role].length))
        ] }),
        /* @__PURE__ */ jsx6(Text6, { dimColor: turn.role === "tool_result", children: truncate(turn.text, Math.max(10, width - roleW - 3)) })
      ] }, `${scroll + i}`))
    ] })
  ] });
}

// src/app.tsx
import { jsx as jsx7, jsxs as jsxs6 } from "react/jsx-runtime";
function filterProjects(projects, query) {
  const q = query.trim().toLowerCase();
  if (!q) return projects;
  const out = [];
  for (const p of projects) {
    const projectMatches = p.label.toLowerCase().includes(q) || p.path.toLowerCase().includes(q) || p.dir.toLowerCase().includes(q) || p.supervision.status.includes(q) || p.supervision.actions.some((a) => a.kind.includes(q) || a.label.toLowerCase().includes(q));
    const sessions = projectMatches ? p.sessions : p.sessions.filter(
      (s) => s.title.toLowerCase().includes(q) || s.status.toLowerCase().includes(q) || s.snippet.toLowerCase().includes(q)
    );
    if (sessions.length > 0) out.push({ ...p, sessions });
  }
  return out;
}
function App({
  claudeHome,
  refreshInterval,
  watch,
  git,
  ai,
  userTasks,
  checkSecrets,
  initialFilter,
  once = false
}) {
  const { stdout } = useStdout();
  const { exit } = useApp2();
  const width = Math.max(60, stdout?.columns ?? 100);
  const height = Math.max(12, stdout?.rows ?? 30);
  const { projects, loading, error, refresh, summarize, summaries, summaryTick } = useSessions({
    claudeHome,
    refreshInterval,
    watch,
    git,
    ai,
    userTasks,
    checkSecrets
  });
  const [filter, setFilter] = useState2(initialFilter);
  const [filterDraft, setFilterDraft] = useState2(initialFilter);
  const [filtering, setFiltering] = useState2(false);
  const [cursor, setCursor] = useState2(0);
  const [sessionCursor, setSessionCursor] = useState2(0);
  const [openDir, setOpenDir] = useState2(null);
  const [openFile, setOpenFile] = useState2(null);
  const [scroll, setScroll] = useState2(0);
  const [now, setNow] = useState2(() => /* @__PURE__ */ new Date());
  useEffect2(() => {
    const t = setInterval(() => setNow(/* @__PURE__ */ new Date()), 1e3);
    return () => clearInterval(t);
  }, []);
  useEffect2(() => {
    if (!once || loading) return;
    const t = setTimeout(() => exit(), 80);
    return () => clearTimeout(t);
  }, [once, loading, exit]);
  const visibleProjects = useMemo2(
    () => filterProjects(projects, filtering ? filterDraft : filter),
    [projects, filter, filterDraft, filtering]
  );
  const projectIndex = visibleProjects.length === 0 ? 0 : Math.min(cursor, visibleProjects.length - 1);
  const currentProject = visibleProjects[projectIndex];
  const openProject = useMemo2(
    () => openDir ? projects.find((p) => p.dir === openDir) ?? null : null,
    [projects, openDir]
  );
  const openSession = useMemo2(() => {
    if (!openFile) return null;
    for (const p of projects) {
      const found = p.sessions.find((s) => s.filePath === openFile);
      if (found) return found;
    }
    return null;
  }, [projects, openFile]);
  const view = openSession ? "detail" : openProject ? "project" : "root";
  const sessionIndex = openProject ? Math.min(sessionCursor, Math.max(0, openProject.sessions.length - 1)) : 0;
  const panelH = Math.max(6, height - 8);
  const innerW = width - 4;
  const innerH = panelH - 2;
  const maxScroll = openSession ? Math.max(0, openSession.turns.length - transcriptCapacity(openSession, innerH)) : 0;
  useKeymap(
    { filtering, view: view === "detail" ? "detail" : "root" },
    {
      onUp: () => {
        if (view === "detail") setScroll((s) => Math.max(0, s - 1));
        else if (view === "project") setSessionCursor((c) => Math.max(0, Math.min(c, sessionIndex) - 1));
        else setCursor((c) => Math.max(0, Math.min(c, projectIndex) - 1));
      },
      onDown: () => {
        if (view === "detail") setScroll((s) => Math.min(maxScroll, s + 1));
        else if (view === "project" && openProject)
          setSessionCursor((c) => Math.min(openProject.sessions.length - 1, c + 1));
        else setCursor((c) => Math.min(visibleProjects.length - 1, c + 1));
      },
      onEnter: () => {
        if (view === "detail") return;
        if (view === "project" && openProject) {
          const session = openProject.sessions[sessionIndex];
          if (!session) return;
          setOpenFile(session.filePath);
          setScroll(Math.max(0, session.turns.length - transcriptCapacity(session, innerH)));
          return;
        }
        if (currentProject) {
          setOpenDir(currentProject.dir);
          setSessionCursor(0);
        }
      },
      onBack: () => {
        if (view === "detail") {
          setOpenFile(null);
          setScroll(0);
        } else if (view === "project") {
          setOpenDir(null);
        }
      },
      onToggleFold: () => {
      },
      onRefresh: refresh,
      onSummarize: () => {
        const target = view === "project" ? openProject : currentProject;
        if (target) summarize(target.dir);
      },
      onStartFilter: () => {
        if (view !== "root") return;
        setFilterDraft(filter);
        setFiltering(true);
      },
      onFilterChar: (char) => setFilterDraft((d) => d + char),
      onFilterBackspace: () => setFilterDraft((d) => d.slice(0, -1)),
      onFilterCommit: () => {
        setFilter(filterDraft);
        setFiltering(false);
        setCursor(0);
      },
      onFilterCancel: () => {
        setFilterDraft(filter);
        setFiltering(false);
      }
    }
  );
  const note = !watch && refreshInterval === 0 ? "manual refresh only" : !watch ? "poll-only" : void 0;
  const sessionsTotal = projects.reduce((n, p) => n + p.sessions.length, 0);
  const needs = projects.reduce((n, p) => n + p.supervision.actions.length, 0);
  const runningCount = projects.reduce((n, p) => n + p.sessions.filter((s) => s.status === "running").length, 0);
  const metrics = [
    { label: "Projects", value: String(projects.length) },
    { label: "Sessions", value: String(sessionsTotal) },
    { label: "Needs you", value: String(needs) },
    { label: "Running", value: String(runningCount) }
  ];
  if (loading) {
    return /* @__PURE__ */ jsx7(Box7, { padding: 1, children: /* @__PURE__ */ jsx7(Spinner, { label: `Scanning ${claudeHome} \u2026` }) });
  }
  const framed = (status, statusColor, progress, panel, keys, body) => /* @__PURE__ */ jsxs6(Box7, { flexDirection: "column", width, children: [
    /* @__PURE__ */ jsx7(Rule, { width, edge: "top" }),
    /* @__PURE__ */ jsx7(
      HeaderBar,
      {
        width,
        path: claudeHome,
        metrics,
        status,
        statusColor,
        progress: progress.ratio,
        progressLabel: progress.label
      }
    ),
    /* @__PURE__ */ jsx7(Rule, { width, edge: "middle" }),
    /* @__PURE__ */ jsx7(Panel, { width, height: panelH, title: panel.title, subtitle: panel.subtitle, meta: panel.meta, children: body }),
    /* @__PURE__ */ jsx7(Rule, { width, edge: "middle" }),
    /* @__PURE__ */ jsx7(FooterBar, { width, keys, note, error }),
    /* @__PURE__ */ jsx7(Rule, { width, edge: "bottom" })
  ] });
  if (openSession) {
    const prog = planProgress(openSession.plan);
    return framed(
      openSession.status.toUpperCase(),
      openSession.status === "running" ? "#E8722A" : openSession.status === "failed" ? "#FF7B7B" : "gray",
      // No plan: the bar is the reading position in the transcript.
      prog.total ? { ratio: prog.completed / prog.total, label: `${prog.completed}/${prog.total}` } : { ratio: maxScroll ? Math.min(scroll, maxScroll) / maxScroll : 1, label: `${openSession.turns.length} turns` },
      { title: "Session", subtitle: `#${openSession.sessionId.slice(0, 8)}  ${openSession.title}`, meta: `${glyphForStatus(openSession.status)} ${openSession.status} \xB7 ${agoLabel(openSession.lastActivity, now)}` },
      [
        { key: "\u2191\u2193", label: "Scroll" },
        { key: "Esc", label: "Back" },
        { key: "R", label: "Refresh" },
        { key: "Q", label: "Quit" }
      ],
      /* @__PURE__ */ jsx7(SessionDetail, { session: openSession, scroll: Math.min(scroll, maxScroll), width: innerW, height: innerH, now })
    );
  }
  if (openProject) {
    const s = openProject.supervision;
    const planned = openProject.sessions.find((x) => x.plan.tasks.length > 0);
    const prog = planned ? planProgress(planned.plan) : { completed: 0, total: 0 };
    return framed(
      s.status === "action" ? "NEEDS YOU" : s.status.toUpperCase(),
      s.status === "action" ? "#FF7B7B" : s.status === "running" ? "#E8722A" : "gray",
      { ratio: prog.total ? prog.completed / prog.total : 0, label: prog.total ? `${prog.completed}/${prog.total}` : `${openProject.sessions.length} sessions` },
      { title: "Project", subtitle: openProject.label, meta: `${glyphForProject(s.status)} ${s.status} \xB7 ${agoLabel(openProject.lastActivity, now)}` },
      [
        { key: "\u2191\u2193", label: "Sessions" },
        { key: "\u23CE", label: "Transcript" },
        ...ai ? [{ key: "A", label: "Next steps" }] : [],
        { key: "Esc", label: "Back" },
        { key: "R", label: "Refresh" },
        { key: "Q", label: "Quit" }
      ],
      /* @__PURE__ */ jsx7(ProjectView, { project: openProject, cursor: sessionIndex, width: innerW, height: innerH, now })
    );
  }
  const shownSessions = visibleProjects.reduce((n, p) => n + p.sessions.length, 0);
  const isFiltered = (filtering ? filterDraft : filter).trim().length > 0;
  return /* @__PURE__ */ jsx7(
    Dashboard,
    {
      claudeHome,
      projects: visibleProjects,
      allProjects: projects,
      selected: projectIndex,
      width,
      height,
      now,
      filter: isFiltered || filtering ? { value: filtering ? filterDraft : filter, active: filtering, matches: shownSessions } : void 0,
      note,
      error,
      ai,
      summary: currentProject ? summaries.get(currentProject.dir) : void 0,
      summaryTick
    }
  );
}

// src/data/snapshot.ts
function renderSnapshot(projects, now = /* @__PURE__ */ new Date()) {
  const lines = [];
  const sessions = projects.reduce((n, p) => n + p.sessions.length, 0);
  const actions = projects.reduce((n, p) => n + p.supervision.actions.length, 0);
  const yours = projects.reduce((n, p) => n + p.supervision.userTasks.filter((t) => t.blocking).length, 0);
  lines.push(
    `control-tower: ${projects.length} projects, ${sessions} sessions` + (actions > 0 ? `, ${actions} need${actions === 1 ? "s" : ""} you` : "") + (yours > 0 ? `, ${yours} on you` : "")
  );
  if (projects.length === 0) {
    lines.push("(no sessions found)");
    return lines.join("\n");
  }
  for (const p of projects) {
    const s = p.supervision;
    const git = describeGit(s.git);
    const pr = s.prLinks[0];
    lines.push("");
    lines.push(
      [
        glyphForProject(s.status),
        s.status.padEnd(8),
        p.label.padEnd(24),
        [git, pr ? `PR #${pr.number}` : "", timeAgo(p.lastActivity, now)].filter(Boolean).join("  "),
        " " + p.path
      ].join(" ").trimEnd()
    );
    for (const a of s.actions) {
      const opts = a.options && a.options.length > 0 ? `  [${a.options.join(" | ")}]` : "";
      lines.push(`  ! ${labelForAction(a.kind).padEnd(9)} ${truncate(a.label + opts, 110)}  (${a.sessionId.slice(0, 8)})`);
    }
    for (const t of s.userTasks) {
      lines.push(
        `  ${t.blocking ? "\u25B2" : "\u25B3"} ${"you".padEnd(9)} ${truncate(t.label + (t.where ? `  (${t.where})` : ""), 110)}`
      );
    }
    if (s.whereWeAre) lines.push(`    ${"now".padEnd(9)} ${truncate(s.whereWeAre.text, 110)}`);
    if (s.nextSteps.length > 0) {
      lines.push(
        `    ${"next".padEnd(9)} ${truncate(
          s.nextSteps.map((n) => `${glyphForStep(n)} ${n.label}`).join("  |  "),
          110
        )}`
      );
    }
    for (const x of p.sessions) {
      lines.push(
        [
          "   ",
          glyphForStatus(x.status),
          x.status.padEnd(8),
          timeAgo(x.lastActivity, now).padStart(5),
          truncate(x.title, 44).padEnd(44),
          truncate(x.snippet, 50)
        ].join(" ").trimEnd()
      );
    }
  }
  return lines.join("\n");
}

// src/cli.tsx
import { jsx as jsx8 } from "react/jsx-runtime";
function parseInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new InvalidArgumentError("must be a non-negative number of milliseconds");
  }
  return n;
}
function buildProgram() {
  const program = new Command();
  program.name("control-tower").description(
    "Supervise every project you run Claude Code in: state, what it needs from you,\nwhere the work got to, what comes next. Local and read-only."
  ).version("0.1.0").option("-p, --path <path>", "path to the Claude home directory", "$HOME/.claude").option(
    "-r, --refresh-interval <ms>",
    "poll interval in ms (0 = rely on the fs watcher alone)",
    parseInterval,
    2e3
  ).option("-f, --filter <pattern>", "initial filter on project or session title").option("--no-watch", "disable the fs watcher and poll only").option("--no-git", "do not read git state from project directories").option("--no-user-tasks", "do not read .env.example / .env key NAMES for what only you can do").option("--secrets", "also ask GitHub which repository secrets exist (needs gh and the network)").option(
    "--ai",
    "allow asking Claude for next steps (key A). Sends the tail of a project\u2019s newest session to the Claude API and caches the answer"
  ).option("--once", "paint one frame and exit; plain text when piped (for scripting)").option("--plain", "with --once: force the plain-text form even on a terminal");
  return program;
}
async function main() {
  const program = buildProgram();
  program.parse(process.argv);
  const opts = program.opts();
  const rawPath = opts.path === "$HOME/.claude" ? void 0 : opts.path;
  const claudeHome = resolveClaudeHome(rawPath);
  if (opts.once) {
    const projects = await loadProjects(claudeHome, new SessionCache(), /* @__PURE__ */ new Date(), {
      git: opts.git ? new GitStateCache() : void 0,
      userTasks: opts.userTasks,
      checkSecrets: opts.secrets
    });
    const filtered = opts.filter ? filterProjects(projects, opts.filter) : projects;
    if (opts.ai) {
      const store = new SummaryStore();
      await store.load();
      await Promise.all(
        filtered.map(
          (p) => store.request(p.dir, p.label, p.path, p.sessions, p.supervision.git, p.lastActivity, () => {
          })
        )
      );
      for (const p of filtered) {
        p.supervision.nextSteps = [...p.supervision.nextSteps, ...summarySteps(store.get(p.dir))];
      }
    }
    if (opts.plain || !process.stdout.isTTY) {
      process.stdout.write(renderSnapshot(filtered) + "\n");
      return;
    }
    const shot = render(
      /* @__PURE__ */ jsx8(
        App,
        {
          claudeHome,
          refreshInterval: 0,
          watch: false,
          git: opts.git,
          ai: opts.ai ?? false,
          userTasks: opts.userTasks,
          checkSecrets: opts.secrets ?? false,
          initialFilter: opts.filter ?? "",
          once: true
        }
      ),
      { exitOnCtrlC: true }
    );
    await shot.waitUntilExit();
    return;
  }
  if (!process.stdout.isTTY) {
    process.stderr.write(
      "control-tower: not a TTY \u2014 use --once for a plain-text snapshot.\n"
    );
    process.exitCode = 1;
    return;
  }
  const app = render(
    /* @__PURE__ */ jsx8(
      App,
      {
        claudeHome,
        refreshInterval: opts.refreshInterval,
        watch: opts.watch,
        git: opts.git,
        ai: opts.ai ?? false,
        userTasks: opts.userTasks,
        checkSecrets: opts.secrets ?? false,
        initialFilter: opts.filter ?? ""
      }
    ),
    // Ink's default alt-screen behaviour leaves the terminal scrollback intact.
    { exitOnCtrlC: true }
  );
  await app.waitUntilExit();
}
main().catch((error) => {
  process.stderr.write(
    `control-tower: ${error instanceof Error ? error.message : String(error)}
`
  );
  process.exitCode = 1;
});
export {
  buildProgram
};
