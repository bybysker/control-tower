import { describe, expect, it } from 'vitest';
import { columns, fit, timeAgo, truncate, truncateStart } from '../src/utils/format.js';

/**
 * Column layout must be measured in terminal cells, not UTF-16 code units.
 * These guard the two ways that drifted on real data: emoji in titles, and a
 * glyph with emoji presentation (U+25B6 ▶) that draws two cells wide.
 */
describe('truncate / fit measure terminal columns', () => {
  it('replaces a double-width emoji with a one-column placeholder', () => {
    // Ink writes wide characters one cell too wide and breaks the frame, so
    // they never reach the screen: `·` keeps the row exact.
    expect(columns('🔗 Repo')).toBe(7);
    expect(truncate('🔗 Repo', 80)).toBe('· Repo');
    expect(columns(truncate('🔗 Repo', 5))).toBe(5);
  });

  it('pads to an exact column width after sanitising', () => {
    const padded = fit('🔗 x', 8);
    expect(columns(padded)).toBe(8);
    expect(padded).toBe('· x     ');
  });

  it('keeps a truncated string at exactly max columns', () => {
    const t = truncate('Update bootcamp skills with new pedagogical decomposition', 20);
    expect(columns(t)).toBe(20);
    expect(t.endsWith('…')).toBe(true);
  });

  it('truncateStart keeps the tail of a path, where the meaning is', () => {
    expect(truncateStart('/home/alice/.claude', 40)).toBe('/home/alice/.claude');
    // Fills the budget with as much tail as fits, rather than stopping at a
    // separator: the extra characters are free information.
    expect(truncateStart('/private/tmp/very/long/path/demo-store', 14)).toBe('…th/demo-store');
    expect(columns(truncateStart('/private/tmp/very/long/path/demo-store', 14))).toBe(14);
    expect(truncateStart('/private/tmp/very/long/path/demo-store', 12)).toBe('…/demo-store');
    expect(truncateStart('abc', 1)).toBe('…');
    expect(truncateStart('abc', 0)).toBe('');
  });

  it('uses fold glyphs that draw one column wide', () => {
    // ▶ (U+25B6) has emoji presentation and measures 2; the UI uses ▸/▾.
    expect(columns('▸')).toBe(1);
    expect(columns('▾')).toBe(1);
    expect(columns('▶')).toBe(2);
  });

  it('collapses inner whitespace and trims', () => {
    expect(truncate('  a \n b\t c  ', 80)).toBe('a b c');
    expect(truncate('abc', 0)).toBe('');
    expect(truncate('abc', 1)).toBe('…');
  });
});

describe('timeAgo', () => {
  it('reads "now" under a second and compact units after', () => {
    const now = new Date('2026-09-01T12:00:00Z');
    expect(timeAgo(new Date('2026-09-01T11:59:59.600Z'), now)).toBe('now');
    expect(timeAgo(new Date('2026-09-01T11:59:55Z'), now)).toBe('5s');
    expect(timeAgo(new Date('2026-09-01T11:30:00Z'), now)).toBe('30m');
    expect(timeAgo(new Date('2026-09-01T08:00:00Z'), now)).toBe('4h');
    expect(timeAgo(new Date('2026-08-29T12:00:00Z'), now)).toBe('3d');
  });

  it('never throws on an invalid date', () => {
    expect(timeAgo(new Date('nope'))).toBe('—');
  });
});
