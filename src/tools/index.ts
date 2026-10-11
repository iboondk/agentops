import path from 'node:path';
import { calculatorTool } from './calculator.js';
import { createFsSearchTool } from './fsSearch.js';
import { createHttpFetchTool } from './httpFetch.js';
import { ToolRegistry } from './registry.js';

export { ToolRegistry, defineTool } from './registry.js';
export type { ToolDef, ToolSpec, ToolContext } from './registry.js';

export function createDefaultRegistry(opts?: {
  sandboxDir?: string;
  fetchImpl?: typeof fetch;
}): ToolRegistry {
  const sandbox = path.resolve(opts?.sandboxDir ?? process.env.TOOLS_SANDBOX_DIR ?? './sandbox');
  return new ToolRegistry()
    .register(calculatorTool)
    .register(createHttpFetchTool(opts?.fetchImpl ?? fetch))
    .register(createFsSearchTool(sandbox));
}
