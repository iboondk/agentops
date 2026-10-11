import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { createDefaultRegistry } from '../src/tools/index.js';

const fakeFetch = (async () =>
  new Response('ok', { status: 200 })) as unknown as typeof fetch;

async function connectPair() {
  const server = buildMcpServer(createDefaultRegistry({ fetchImpl: fakeFetch }));
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

function firstText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  const item = content[0];
  if (!item || item.type !== 'text' || typeof item.text !== 'string') {
    throw new Error('expected a text content item');
  }
  return item.text;
}

describe('MCP server (in-memory transport)', () => {
  it('lists exactly the three tools with object input schemas', async () => {
    const { client } = await connectPair();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['calculator', 'fs_search', 'http_fetch']);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.description).toBe('string');
    }
  });

  it('calculator returns the evaluated result as text', async () => {
    const { client } = await connectPair();
    const result = await client.callTool({
      name: 'calculator',
      arguments: { expression: '10/4' },
    });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toBe('2.5');
  });

  it('fs_search finds runbook.md for "failover"', async () => {
    const { client } = await connectPair();
    const result = await client.callTool({
      name: 'fs_search',
      arguments: { query: 'failover' },
    });
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toContain('runbook.md');
  });

  it('returns isError for a division by zero', async () => {
    const { client } = await connectPair();
    const result = await client.callTool({
      name: 'calculator',
      arguments: { expression: '1/0' },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/^ERROR: /);
  });

  it('returns isError for an unknown tool', async () => {
    const { client } = await connectPair();
    const result = await client.callTool({ name: 'no_such_tool', arguments: {} });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/^ERROR: .*Unknown tool/);
  });
});
