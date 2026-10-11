import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentError } from '../src/core/errors.js';
import { calculatorTool } from '../src/tools/calculator.js';
import { createFsSearchTool } from '../src/tools/fsSearch.js';
import { createHttpFetchTool } from '../src/tools/httpFetch.js';
import { createDefaultRegistry } from '../src/tools/index.js';
import { ToolRegistry } from '../src/tools/registry.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const sandboxDir = path.join(projectRoot, 'sandbox');
const tmpBase = path.join(projectRoot, 'data', 'tmp');

describe('calculator', () => {
  const registry = new ToolRegistry().register(calculatorTool);

  it("evaluates '2*(3+4)^2' to 98", async () => {
    expect(await registry.execute('calculator', { expression: '2*(3+4)^2' })).toBe('98');
  });

  it("evaluates unary minus '-3+5' to 2", async () => {
    expect(await registry.execute('calculator', { expression: '-3+5' })).toBe('2');
  });

  it('respects precedence for unary minus and power, and decimals and modulo', async () => {
    expect(await registry.execute('calculator', { expression: '-2^2' })).toBe('-4');
    expect(await registry.execute('calculator', { expression: '2^3^2' })).toBe('512');
    expect(await registry.execute('calculator', { expression: '0.5+0.25' })).toBe('0.75');
    expect(await registry.execute('calculator', { expression: '10%3' })).toBe('1');
  });

  it('rejects division by zero with AgentError', async () => {
    await expect(registry.execute('calculator', { expression: '1/0' })).rejects.toBeInstanceOf(
      AgentError,
    );
  });

  it("rejects 'process.exit()' as a syntax error", async () => {
    await expect(
      registry.execute('calculator', { expression: 'process.exit()' }),
    ).rejects.toBeInstanceOf(AgentError);
  });
});

describe('fs_search', () => {
  it('finds "failover" in the sandbox runbook', async () => {
    const registry = new ToolRegistry().register(createFsSearchTool(sandboxDir));
    const out = await registry.execute('fs_search', { query: 'failover' });
    expect(out).toContain('runbook.md:');
    expect(out.toLowerCase()).toContain('failover');
  });

  it('returns "no matches" when nothing matches', async () => {
    const registry = new ToolRegistry().register(createFsSearchTool(sandboxDir));
    expect(await registry.execute('fs_search', { query: 'zzz-not-present-zzz' })).toBe(
      'no matches',
    );
  });

  it('never returns content from outside the root (traversal and symlink escape)', async () => {
    await fs.mkdir(tmpBase, { recursive: true });
    const base = await fs.mkdtemp(path.join(tmpBase, 'fs-'));
    try {
      const root = path.join(base, 'root');
      const outsideDir = path.join(base, 'outside');
      await fs.mkdir(root);
      await fs.mkdir(outsideDir);
      await fs.writeFile(path.join(root, 'inside.txt'), 'failover inside\n');
      await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'failover OUTSIDE-SECRET\n');
      await fs.symlink(path.join(outsideDir, 'secret.txt'), path.join(root, 'link.txt'));
      await fs.symlink(outsideDir, path.join(root, 'linkdir'));

      const registry = new ToolRegistry().register(createFsSearchTool(root));
      const out = await registry.execute('fs_search', { query: 'failover' });
      expect(out).toContain('inside.txt:1: failover inside');
      expect(out).not.toContain('OUTSIDE-SECRET');
      expect(out).not.toContain('link.txt');
      expect(out).not.toContain('linkdir');
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('validates maxResults bounds through the registry', async () => {
    const registry = new ToolRegistry().register(createFsSearchTool(sandboxDir));
    await expect(
      registry.execute('fs_search', { query: 'failover', maxResults: 51 }),
    ).rejects.toBeInstanceOf(AgentError);
  });
});

describe('http_fetch', () => {
  let savedAllowlist: string | undefined;

  beforeEach(() => {
    savedAllowlist = process.env.HTTP_FETCH_ALLOWLIST;
    delete process.env.HTTP_FETCH_ALLOWLIST;
  });

  afterEach(() => {
    if (savedAllowlist === undefined) delete process.env.HTTP_FETCH_ALLOWLIST;
    else process.env.HTTP_FETCH_ALLOWLIST = savedAllowlist;
  });

  it('returns "status: 200" and the body with an injected fake fetch', async () => {
    const fake = vi.fn(async () => new Response('hello world', { status: 200 }));
    const registry = new ToolRegistry().register(
      createHttpFetchTool(fake as unknown as typeof fetch),
    );
    const out = await registry.execute('http_fetch', { url: 'https://example.com/' });
    expect(out).toBe('status: 200\n\nhello world');
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it('rejects file:// URLs without calling fetch', async () => {
    const fake = vi.fn(async () => new Response('secret', { status: 200 }));
    const registry = new ToolRegistry().register(
      createHttpFetchTool(fake as unknown as typeof fetch),
    );
    await expect(
      registry.execute('http_fetch', { url: 'file:///etc/passwd' }),
    ).rejects.toBeInstanceOf(AgentError);
    expect(fake).not.toHaveBeenCalled();
  });

  it('retries on 503 and then succeeds', async () => {
    let calls = 0;
    const fake = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response('down', { status: 503 })
        : new Response('ok', { status: 200 });
    });
    const registry = new ToolRegistry().register(
      createHttpFetchTool(fake as unknown as typeof fetch),
    );
    const out = await registry.execute('http_fetch', { url: 'https://example.com/a' });
    expect(out).toBe('status: 200\n\nok');
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it('enforces HTTP_FETCH_ALLOWLIST', async () => {
    process.env.HTTP_FETCH_ALLOWLIST = 'example.com, docs.example.org';
    const fake = vi.fn(async () => new Response('x', { status: 200 }));
    const registry = new ToolRegistry().register(
      createHttpFetchTool(fake as unknown as typeof fetch),
    );
    await expect(registry.execute('http_fetch', { url: 'https://evil.test/' })).rejects.toBeInstanceOf(
      AgentError,
    );
    expect(fake).not.toHaveBeenCalled();
    expect(await registry.execute('http_fetch', { url: 'https://example.com/' })).toBe(
      'status: 200\n\nx',
    );
  });
});

describe('ToolRegistry', () => {
  it('rejects invalid args with AgentError', async () => {
    const registry = createDefaultRegistry({ sandboxDir });
    await expect(registry.execute('calculator', { expression: 42 })).rejects.toBeInstanceOf(
      AgentError,
    );
    await expect(registry.execute('calculator', {})).rejects.toThrow(/Invalid arguments/);
  });

  it('rejects unknown tools with AgentError', async () => {
    const registry = createDefaultRegistry({ sandboxDir });
    await expect(registry.execute('nope', {})).rejects.toThrow(/Unknown tool/);
  });

  it('exposes JSON Schema specs without $schema', () => {
    const specs = createDefaultRegistry({ sandboxDir }).specs();
    expect(specs.map((s) => s.name).sort()).toEqual(['calculator', 'fs_search', 'http_fetch']);
    for (const s of specs) {
      expect(s.inputSchema).not.toHaveProperty('$schema');
      expect(s.inputSchema.type).toBe('object');
    }
  });
});
