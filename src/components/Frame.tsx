import React from 'react';
import { Box, Text } from 'ink';
import { Line, type Seg } from './Line.js';
import { columns, truncateStart } from '../utils/format.js';

/**
 * The frame every view lives in: box-drawing chrome, a two-line header
 * (identity + metrics, then a status bar), titled panels, and a key legend.
 *
 * Horizontal rules are plain Text of exactly `width` columns so junctions
 * (┬ ┴ ├ ┤) land where the columns meet; vertical edges are Ink borders on
 * the panels themselves. Every panel has a fixed height and clips, so the
 * whole frame is always `rows - 1` lines tall -- one short of the height at
 * which Ink stops repainting in place and clears the screen instead.
 */

/** The brand as drawn in the header -- and the width budget it costs. */
export const BRAND = 'Control Tower';
const BRAND_MARK = '∴ ';

export const ACCENT = '#E8722A';
export const CHECK = '#9BB05C';
export const SELECT_BG = '#D9D4CC';
export const RULE = 'gray';

interface RuleProps {
  width: number;
  /** Column (0-based, within the inner width) where a vertical split meets this rule. */
  split?: number;
  /** Whether that split starts below (┬), ends above (┴), or crosses (┼). */
  splitKind?: 'down' | 'up' | 'cross';
  edge: 'top' | 'middle' | 'bottom';
}

export function Rule({ width, split, splitKind = 'down', edge }: RuleProps): React.JSX.Element {
  const inner = Math.max(0, width - 2);
  const chars = Array.from({ length: inner }, () => '─');
  if (split !== undefined && split >= 0 && split < inner) {
    chars[split] = splitKind === 'down' ? '┬' : splitKind === 'up' ? '┴' : '┼';
  }
  const [l, r] = edge === 'top' ? ['┌', '┐'] : edge === 'bottom' ? ['└', '┘'] : ['├', '┤'];
  return <Text color={RULE}>{l + chars.join('') + r}</Text>;
}

interface PanelProps {
  width: number;
  height: number;
  title: string;
  /** Dim text right after the title, e.g. the selected item's name. */
  subtitle?: string;
  /** Right-aligned dim counter, e.g. "16/22". */
  meta?: string;
  /** Left border only (the panel to its right supplies the shared edge). */
  edges?: 'both' | 'left';
  children?: React.ReactNode;
}

/** A bordered, fixed-height, clipping region with a heading row. */
export function Panel({ width, height, title, subtitle, meta, edges = 'both', children }: PanelProps): React.JSX.Element {
  const textW = width - (edges === 'both' ? 2 : 1) - 2;
  return (
    <Box
      width={width}
      height={height}
      flexDirection="column"
      borderStyle="single"
      borderColor={RULE}
      borderTop={false}
      borderBottom={false}
      borderRight={edges === 'both'}
      paddingX={1}
      overflow="hidden"
    >
      <Line
        width={textW}
        segs={[
          { t: title, bold: true },
          // The subtitle takes the slack; without one, an explicit spacer
          // keeps the counter on the right instead of glued to the title.
          subtitle ? { t: '  ' + subtitle, dim: true, flex: true } : { t: '', flex: true },
          ...(meta ? [{ t: meta, dim: true }] : []),
        ]}
      />
      <Line width={textW} segs={[]} />
      {children}
    </Box>
  );
}

export interface Metric {
  label: string;
  value: string;
}

interface HeaderBarProps {
  width: number;
  /** Home directory being watched. */
  path: string;
  metrics: Metric[];
  /** The status word, coloured by `statusColor`. */
  status: string;
  statusColor: string;
  /** 0..1 fill for the bar, plus its right-hand label. */
  progress: number;
  progressLabel: string;
  /** When set, the status row is replaced by a filter prompt. */
  filter?: { value: string; active: boolean; matches: number };
}

export function HeaderBar({
  width,
  path,
  metrics,
  status,
  statusColor,
  progress,
  progressLabel,
  filter,
}: HeaderBarProps): React.JSX.Element {
  const textW = width - 4;
  // The path keeps its tail rather than its head: a long --path otherwise
  // renders as a useless prefix. Budget = width minus brand and metrics.
  const metricsW = metrics.reduce((n, m) => n + columns(m.label) + columns(m.value) + 1, 0) + (metrics.length - 1) * 3;
  const pathW = Math.max(8, textW - columns(BRAND_MARK + BRAND) - metricsW - 4);
  const metricSegs: Seg[] = metrics.flatMap((m, i) => [
    ...(i > 0 ? [{ t: ' · ', dim: true }] : []),
    { t: m.label + ' ', dim: true },
    { t: m.value, bold: true },
  ]);
  const barLabel = progressLabel;
  const barW = Math.max(4, textW - 2 - status.length - 2 - barLabel.length - 2);
  const filled = Math.round(Math.max(0, Math.min(1, progress)) * barW);
  return (
    <Box
      width={width}
      flexDirection="column"
      borderStyle="single"
      borderColor={RULE}
      borderTop={false}
      borderBottom={false}
      paddingX={1}
    >
      <Line
        width={textW}
        segs={[
          { t: BRAND_MARK, color: ACCENT },
          { t: BRAND, bold: true, color: ACCENT },
          { t: '  ' + truncateStart(path, pathW), dim: true, flex: true },
          { t: '  ' },
          ...metricSegs,
        ]}
      />
      {filter ? (
        <Line
          width={textW}
          segs={[
            { t: '/', color: filter.active ? ACCENT : undefined, bold: true },
            { t: filter.value },
            { t: filter.active ? '▊' : '', color: ACCENT },
            { t: `  ${filter.matches} match${filter.matches === 1 ? '' : 'es'}`, dim: true, flex: true },
            { t: filter.active ? 'type to filter · ⏎ apply · esc cancel' : 'esc clear', dim: true },
          ]}
        />
      ) : (
        <Line
          width={textW}
          segs={[
            { t: '● ', color: statusColor },
            { t: status, bold: true, color: statusColor },
            { t: '  ' },
            { t: '▒'.repeat(filled), color: statusColor },
            { t: '░'.repeat(Math.max(0, barW - filled)), dim: true, flex: true },
            { t: '  ' + barLabel, bold: true },
          ]}
        />
      )}
    </Box>
  );
}

export interface KeyHint {
  key: string;
  label: string;
}

interface FooterBarProps {
  width: number;
  keys: KeyHint[];
  /** e.g. "poll-only", shown dim at the right. */
  note?: string;
  error?: string;
}

export function FooterBar({ width, keys, note, error }: FooterBarProps): React.JSX.Element {
  const textW = width - 4;
  const segs: Seg[] = keys.flatMap((k, i) => [
    ...(i > 0 ? [{ t: '   ' }] : []),
    { t: k.key, bold: true },
    { t: ' ' + k.label, dim: true },
  ]);
  return (
    <Box width={width} borderStyle="single" borderColor={RULE} borderTop={false} borderBottom={false} paddingX={1}>
      <Line
        width={textW}
        segs={
          error
            ? [{ t: '! ' + error, color: 'red', flex: true }]
            : [...segs, { t: '', flex: true }, ...(note ? [{ t: note, dim: true }] : [])]
        }
      />
    </Box>
  );
}
