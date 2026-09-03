import type { Project } from './types.js';
import { glyphForProject, glyphForStatus, glyphForStep, labelForAction, timeAgo, truncate } from '../utils/format.js';
import { describeGit } from './project.js';

/**
 * Plain-ASCII snapshot for `--once`.
 *
 * Grep-friendly on purpose: the project line carries its status as a bare word
 * in a fixed column, every action line starts with `  !`, every session line
 * with two spaces and a glyph. So `--once | grep '^  !'` lists everything that
 * needs you, and `--once | grep -c running` counts what is working.
 */
export function renderSnapshot(projects: Project[], now = new Date()): string {
  const lines: string[] = [];
  const sessions = projects.reduce((n, p) => n + p.sessions.length, 0);
  const actions = projects.reduce((n, p) => n + p.supervision.actions.length, 0);
  const yours = projects.reduce((n, p) => n + p.supervision.userTasks.filter((t) => t.blocking).length, 0);

  lines.push(
    `control-tower: ${projects.length} projects, ${sessions} sessions` +
      (actions > 0 ? `, ${actions} need${actions === 1 ? 's' : ''} you` : '') +
      (yours > 0 ? `, ${yours} on you` : ''),
  );
  if (projects.length === 0) {
    lines.push('(no sessions found)');
    return lines.join('\n');
  }

  for (const p of projects) {
    const s = p.supervision;
    const git = describeGit(s.git);
    const pr = s.prLinks[0];
    lines.push('');
    lines.push(
      [
        glyphForProject(s.status),
        s.status.padEnd(8),
        p.label.padEnd(24),
        [git, pr ? `PR #${pr.number}` : '', timeAgo(p.lastActivity, now)].filter(Boolean).join('  '),
        ' ' + p.path,
      ].join(' ').trimEnd(),
    );
    for (const a of s.actions) {
      const opts = a.options && a.options.length > 0 ? `  [${a.options.join(' | ')}]` : '';
      lines.push(`  ! ${labelForAction(a.kind).padEnd(9)} ${truncate(a.label + opts, 110)}  (${a.sessionId.slice(0, 8)})`);
    }
    for (const t of s.userTasks) {
      lines.push(
        `  ${t.blocking ? '▲' : '△'} ${'you'.padEnd(9)} ${truncate(t.label + (t.where ? `  (${t.where})` : ''), 110)}`,
      );
    }
    if (s.whereWeAre) lines.push(`    ${'now'.padEnd(9)} ${truncate(s.whereWeAre.text, 110)}`);
    if (s.nextSteps.length > 0) {
      lines.push(
        `    ${'next'.padEnd(9)} ${truncate(
          s.nextSteps.map((n) => `${glyphForStep(n)} ${n.label}`).join('  |  '),
          110,
        )}`,
      );
    }
    for (const x of p.sessions) {
      lines.push(
        [
          '   ',
          glyphForStatus(x.status),
          x.status.padEnd(8),
          timeAgo(x.lastActivity, now).padStart(5),
          truncate(x.title, 44).padEnd(44),
          truncate(x.snippet, 50),
        ].join(' ').trimEnd(),
      );
    }
  }
  return lines.join('\n');
}
