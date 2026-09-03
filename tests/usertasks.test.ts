import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deriveUserTasks, isHumanOnly, readEnvFinding, referencedSecrets } from '../src/data/usertasks.js';

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-ut-'));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }
  return dir;
}

describe('privacy: names leave, values never do', () => {
  it('never returns, labels, or otherwise exposes a value from .env', async () => {
    const SECRET = 'sk-ant-THIS-MUST-NEVER-APPEAR-anywhere';
    const dir = await repo({
      '.env.example': 'ANTHROPIC_API_KEY=\nLOG_LEVEL=\nSTRIPE_SECRET_KEY=',
      '.env': `ANTHROPIC_API_KEY=${SECRET}\nLOG_LEVEL=debug\nSTRIPE_SECRET_KEY=`,
    });
    const tasks = await deriveUserTasks(dir);
    const dumped = JSON.stringify(tasks);
    expect(dumped).not.toContain(SECRET);
    expect(dumped).not.toContain('sk-ant');
    expect(dumped).not.toContain('debug');
    // The filled key is satisfied and says nothing; the empty one is reported.
    expect(tasks.map((t) => t.key)).toEqual(['STRIPE_SECRET_KEY']);
  });

  it('reports a key as satisfied on the strength of its value without revealing it', async () => {
    const dir = await repo({ '.env.example': 'API_KEY=', '.env': 'API_KEY=real-value-here' });
    expect((await readEnvFinding(dir)).missing).toEqual([]);
  });

  it('treats an obvious placeholder as not filled', async () => {
    const dir = await repo({ '.env.example': 'A_API_KEY=\nB_API_KEY=', '.env': 'A_API_KEY=changeme\nB_API_KEY=<your key>' });
    expect((await readEnvFinding(dir)).missing.sort()).toEqual(['A_API_KEY', 'B_API_KEY']);
  });
});

describe('the human / agent split', () => {
  it('sends externally-issued credentials to the human', () => {
    for (const k of ['ANTHROPIC_API_KEY', 'WA_ACCESS_TOKEN', 'WA_APP_SECRET', 'GOOGLE_CLIENT_SECRET',
                     'AZURE_WEBAPP_PUBLISH_PROFILE', 'LANGFUSE_PUBLIC_KEY', 'SENTRY_DSN']) {
      expect(isHumanOnly(k), k).toBe(true);
    }
  });

  it('keeps configuration and local infrastructure delegable', () => {
    // Listing these buries the four that need a browser under twenty that do not.
    for (const k of ['LOG_LEVEL', 'APP_PORT', 'APP_ENV', 'POSTGRES_HOST', 'POSTGRES_PASSWORD',
                     'POSTGRES_DB', 'REDIS_URL', 'CLAUDE_MODEL_FAST', 'RATE_LIMIT_PER_MIN', 'BRAND']) {
      expect(isHumanOnly(k), k).toBe(false);
    }
  });

  it('collapses the delegable ones into a single line marked delegable', async () => {
    const dir = await repo({ '.env.example': 'X_API_KEY=\nLOG_LEVEL=\nAPP_PORT=\nBRAND=' });
    const tasks = await deriveUserTasks(dir);
    expect(tasks.filter((t) => !t.delegable).map((t) => t.key)).toEqual(['X_API_KEY']);
    const rest = tasks.find((t) => t.delegable);
    expect(rest?.label).toContain('3 other .env keys');
    expect(rest?.blocking).toBe(false);
  });

  it('marks everything blocking when there is no .env at all', async () => {
    const dir = await repo({ '.env.example': 'X_API_KEY=' });
    expect((await deriveUserTasks(dir))[0]?.blocking).toBe(true);
  });

  it('says nothing about a project that declares no expectations', async () => {
    expect(await deriveUserTasks(await repo({ 'README.md': 'hi' }))).toEqual([]);
    expect(await deriveUserTasks(undefined)).toEqual([]);
  });
});

describe('referencedSecrets', () => {
  it('collects secrets across workflows and drops the one GitHub always provides', () => {
    expect(referencedSecrets([
      'run: deploy\n  env:\n    A: ${{ secrets.AZURE_WEBAPP_NAME }}\n    B: ${{ secrets.GITHUB_TOKEN }}',
      'x: ${{ secrets.AZURE_WEBAPP_PUBLISH_PROFILE }}\ny: ${{ secrets.AZURE_WEBAPP_NAME }}',
    ])).toEqual(['AZURE_WEBAPP_NAME', 'AZURE_WEBAPP_PUBLISH_PROFILE']);
  });

  it('is silent when no workflow references anything', () => {
    expect(referencedSecrets([])).toEqual([]);
  });
});
