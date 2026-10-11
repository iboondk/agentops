import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createDefaultRegistry } from '../tools/index.js';
import type { ToolRegistry } from '../tools/registry.js';

export function buildMcpServer(registry: ToolRegistry): Server {
  const server = new Server(
    { name: 'agentops-tools', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.specs().map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: { ...spec.inputSchema, type: 'object' as const },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const text = await registry.execute(name, args ?? {});
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `ERROR: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// Run as a stdio MCP server when executed directly (e.g. `npx tsx src/mcp/server.ts`).
const isMain =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const server = buildMcpServer(createDefaultRegistry());
  const transport = new StdioServerTransport();
  server.connect(transport).then(
    () => {
      console.error('agentops-tools MCP server running on stdio');
    },
    (err: unknown) => {
      console.error('Failed to start agentops-tools MCP server:', err);
      process.exit(1);
    },
  );
}
