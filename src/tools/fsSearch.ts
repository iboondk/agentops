import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AgentError } from '../core/errors.js';
import { defineTool } from './registry.js';

const MAX_FILE_BYTES = 1024 * 1024;
const ALLOWED_EXT = new Set(['.md', '.txt', '.json', '.ts']);

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Case-insensitive substring search across text files under `root`.
 * Every entry is resolved with realpath and must stay inside the realpath of `root`,
 * so symlinks or ".." tricks cannot read files outside the sandbox.
 */
export function createFsSearchTool(root: string) {
  const absRoot = path.resolve(root);

  return defineTool({
    name: 'fs_search',
    description:
      'Case-insensitive text search over .md, .txt, .json and .ts files in the sandbox. Returns "path:line: text" matches.',
    schema: z.object({
      query: z.string().min(1).max(100),
      maxResults: z.number().int().min(1).max(50).default(20),
    }),
    timeoutMs: 5000,
    run: async ({ query, maxResults }, { signal }) => {
      let realRoot: string;
      try {
        realRoot = await fs.realpath(absRoot);
      } catch {
        throw new AgentError(`Sandbox root not found: ${absRoot}`);
      }

      const needle = query.toLowerCase();
      const results: string[] = [];
      const visitedDirs = new Set<string>();

      const walk = async (dir: string): Promise<void> => {
        if (signal.aborted) throw signal.reason ?? new AgentError('fs_search aborted');
        if (results.length >= maxResults) return;
        if (visitedDirs.has(dir)) return;
        visitedDirs.add(dir);

        const entries = await fs.readdir(dir, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
          if (results.length >= maxResults) return;
          const full = path.join(dir, entry.name);

          // Realpath check: symlinks that point outside the sandbox are skipped, never read.
          let real: string;
          try {
            real = await fs.realpath(full);
          } catch {
            continue;
          }
          if (!isInside(real, realRoot)) continue;

          const st = await fs.stat(real);
          if (st.isDirectory()) {
            await walk(real);
          } else if (st.isFile()) {
            if (st.size > MAX_FILE_BYTES) continue;
            if (!ALLOWED_EXT.has(path.extname(real).toLowerCase())) continue;
            const text = await fs.readFile(real, 'utf8');
            const rel = path.relative(realRoot, real).split(path.sep).join('/');
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length && results.length < maxResults; i++) {
              const line = lines[i]!;
              if (line.toLowerCase().includes(needle)) {
                results.push(`${rel}:${i + 1}: ${line}`);
              }
            }
          }
        }
      };

      await walk(realRoot);
      return results.length > 0 ? results.join('\n') : 'no matches';
    },
  });
}
