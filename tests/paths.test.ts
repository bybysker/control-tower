import { describe, expect, it } from 'vitest';
import {
  pluginDir,
  decodeProjectDir,
  encodeProjectDir,
  expandTilde,
  resolveClaudeHome,
  resolveProjectPath,
} from '../src/utils/paths.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

describe('encodeProjectDir', () => {
  it('replaces both / and . with -, the way Claude Code names project dirs', () => {
    expect(encodeProjectDir('/home/alice/code')).toBe('-home-alice-code');
    expect(encodeProjectDir('/home/alice/code/bootcamp/rag-eval-v2.1')).toBe(
      '-home-alice-code-bootcamp-rag-eval-v2-1',
    );
  });
});

describe('resolveProjectPath', () => {
  it('picks the candidate that re-encodes to exactly the directory name', () => {
    // cwd moves within a session; the last one visited is usually a subdirectory.
    const candidates = [
      '/home/alice/code/bootcamp/rag-eval-v2',
      '/home/alice/code',
      '/home/alice/code/control-tower',
    ];
    expect(resolveProjectPath('-home-alice-code', candidates)).toBe(
      '/home/alice/code',
    );
  });

  it('recovers a dotted path that decoding could never reconstruct', () => {
    // '-' could have been '/' or '.'; re-encoding settles it exactly.
    expect(
      resolveProjectPath('-home-alice-code-bootcamp-rag-eval-v2-1', [
        '/home/alice/code/bootcamp/rag-eval-v2.1',
      ]),
    ).toBe('/home/alice/code/bootcamp/rag-eval-v2.1');
  });

  it('distinguishes a dashed directory from a dotted one', () => {
    const dir = '-home-alice-code-bootcamp-rag-eval-v2-1';
    expect(resolveProjectPath(dir, ['/home/alice/code/bootcamp/rag-eval-v2-1'])).toBe(
      '/home/alice/code/bootcamp/rag-eval-v2-1',
    );
  });

  it('falls back to the shallowest candidate when none re-encodes exactly', () => {
    expect(
      resolveProjectPath('-some-other-dir', ['/a/b/c/d/e', '/a/b']),
    ).toBe('/a/b');
  });

  it('falls back to the lossy decode when there are no candidates at all', () => {
    expect(resolveProjectPath('-home-alice-code', [])).toBe('/home/alice/code');
  });
});

describe('decodeProjectDir', () => {
  it('assumes every dash was a slash -- lossy, and only a last resort', () => {
    expect(decodeProjectDir('-home-alice-code')).toBe('/home/alice/code');
  });
});

describe('resolveClaudeHome', () => {
  it('defaults to ~/.claude', () => {
    expect(resolveClaudeHome()).toBe(`${os.homedir()}/.claude`);
  });

  it('honours an explicit override and expands ~', () => {
    expect(resolveClaudeHome('/tmp/fake-claude')).toBe('/tmp/fake-claude');
    expect(resolveClaudeHome('~/other')).toBe(`${os.homedir()}/other`);
  });

  it('ignores a blank override', () => {
    expect(resolveClaudeHome('   ')).toBe(`${os.homedir()}/.claude`);
  });
});

describe('expandTilde', () => {
  it('expands a bare tilde and a tilde path, leaving others alone', () => {
    expect(expandTilde('~')).toBe(os.homedir());
    expect(expandTilde('~/x')).toBe(`${os.homedir()}/x`);
    expect(expandTilde('/abs')).toBe('/abs');
  });
});

describe('pluginDir', () => {
  /**
   * The --ai runner executes outside every project on purpose, so the plugin
   * cannot be found from the cwd -- it is resolved from the module's own
   * location. This guards the two layouts that resolution has to survive:
   * <repo>/src/utils at dev time and <package>/dist after bundling.
   */
  it('points at a plugin that actually exists, with its manifest', () => {
    const dir = pluginDir();
    expect(path.basename(dir)).toBe('plugin');
    expect(fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('names the plugin control-tower, which is what --plugin-dir loads', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginDir(), '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { name?: string };
    expect(manifest.name).toBe('control-tower');
  });
});
