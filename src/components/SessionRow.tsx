import React from 'react';
import { Box, Text } from 'ink';
import type { Session } from '../data/types.js';
import { colorForStatus, fit, glyphForStatus, timeAgo, truncate } from '../utils/format.js';

interface SessionRowProps {
  session: Session;
  selected: boolean;
  width: number;
  now: Date;
}

/** Column widths, tuned so the row still reads at an 80-column terminal. */
const STATUS_W = 8;
const AGE_W = 6;

export function SessionRow({ session, selected, width, now }: SessionRowProps): React.JSX.Element {
  const color = colorForStatus(session.status);
  // 4 leading cols (indent + glyph + space) then status / title / age / snippet.
  const remaining = Math.max(20, width - 4 - STATUS_W - 1 - AGE_W - 4);
  const titleW = Math.min(40, Math.max(16, Math.floor(remaining * 0.5)));
  const snippetW = Math.max(0, remaining - titleW);

  return (
    <Box>
      <Text color={selected ? 'cyan' : undefined}>{selected ? '❯ ' : '  '}</Text>
      <Text color={color}>{glyphForStatus(session.status)} </Text>
      <Text color={color}>{fit(session.status, STATUS_W)}</Text>
      <Text bold={selected} color={selected ? 'cyan' : undefined}>
        {fit(session.title, titleW)}
      </Text>
      {/* Explicit gutter: a truncated title fills its column to the last cell
          and otherwise reads as "Widget 2.…4d". */}
      <Text> </Text>
      <Text dimColor>{fit(timeAgo(session.lastActivity, now), AGE_W)}</Text>
      {snippetW > 8 ? <Text dimColor>{truncate(session.snippet, snippetW)}</Text> : null}
    </Box>
  );
}
