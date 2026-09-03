import React from 'react';
import { Box, Text } from 'ink';
import { columns, sanitizeWidth, truncate } from '../utils/format.js';

/**
 * A single terminal row of exactly `width` columns, built from segments.
 *
 * The framed layout depends on every row being exactly as wide as its panel:
 * one column over and Ink wraps the line, pushing every row below it down and
 * breaking the box-drawing frame. So rows are never free-form Text; they are
 * built here, where the one `flex` segment absorbs whatever width is left and
 * the total is padded or truncated to the column count.
 */
export interface Seg {
  t: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
  /** Takes the remaining width. At most one per line; defaults to the last. */
  flex?: boolean;
}

interface LineProps {
  width: number;
  segs: Seg[];
  /** Background for the whole row (selection highlight). */
  bg?: string;
  /** Foreground override for the whole row, used with `bg`. */
  fg?: string;
}

export function Line({ width, segs, bg, fg }: LineProps): React.JSX.Element {
  if (width <= 0) return <Text> </Text>;
  const parts = segs.map((s) => ({ ...s, t: sanitize(s.t) }));
  let flexIndex = parts.findIndex((s) => s.flex);
  if (flexIndex < 0) {
    parts.push({ t: '', flex: true });
    flexIndex = parts.length - 1;
  }
  const fixed = parts.reduce((n, s, i) => (i === flexIndex ? n : n + columns(s.t)), 0);
  let flexW = width - fixed;
  if (flexW < 0) {
    // Fixed segments alone overflow: eat the overflow from the last fixed one.
    let over = -flexW;
    for (let i = parts.length - 1; i >= 0 && over > 0; i--) {
      if (i === flexIndex) continue;
      const p = parts[i];
      if (!p) continue;
      const w = columns(p.t);
      const keep = Math.max(0, w - over);
      over -= w - keep;
      p.t = keep === 0 ? '' : clip(p.t, keep);
    }
    flexW = 0;
  }
  const flex = parts[flexIndex];
  if (flex) {
    const t = clip(flex.t, flexW);
    flex.t = t + ' '.repeat(Math.max(0, flexW - columns(t)));
  }
  return (
    <Box>
      {parts.map((s, i) => (
        <Text
          key={i}
          color={fg ?? s.color}
          dimColor={bg ? false : s.dim}
          bold={s.bold}
          backgroundColor={bg}
        >
          {s.t}
        </Text>
      ))}
    </Box>
  );
}

/** Newlines and tabs become spaces (runs of spaces are layout and survive); wide chars become `·`. */
export function sanitize(text: string): string {
  return sanitizeWidth(text.replace(/[\r\n\t]+/g, ' '));
}

/** Truncate to `max` columns with an ellipsis, WITHOUT collapsing spaces. */
export function clip(text: string, max: number): string {
  if (max <= 0) return '';
  if (columns(text) <= max) return text;
  if (max === 1) return '…';
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = columns(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** Greedy word wrap to `width` columns, at most `max` lines (last one ellipsed). */
export function wrapText(text: string, width: number, max: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let cur = '';
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
  if (lines.length === max && words.join(' ') !== lines.join(' ')) {
    const last = lines[max - 1] ?? '';
    lines[max - 1] = truncate(last + ' …', width);
  }
  return lines;
}
