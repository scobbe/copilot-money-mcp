import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CopilotMoneyServer } from '../../src/server.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import type { CopilotDatabase } from '../../src/core/database.js';

async function exercise(args: Record<string, unknown>, oversized: boolean) {
  const path = mkdtempSync(join(tmpdir(), 'copilot-input-limit-unit-'));
  const app = new CopilotMoneyServer(path);
  let databaseChecks = 0;
  const unavailableDb = {
    isAvailable() {
      databaseChecks++;
      return false;
    },
  } as unknown as CopilotDatabase;
  app._injectForTesting(unavailableDb, new CopilotMoneyTools(unavailableDb));
  const server = (app as unknown as { server: Server }).server;
  const client = new Client({ name: 'input-limit-unit-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: 'get_accounts', arguments: args });
    if (oversized) {
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: 'text', text: 'Tool arguments exceed the maximum of 10000 elements.' },
      ]);
      expect(databaseChecks).toBe(0);
      // Rejection must not break subsequent requests on the same SDK connection.
      const ordinary = await client.callTool({ name: 'get_accounts', arguments: {} });
      expect(ordinary.content).not.toEqual(result.content);
      expect(databaseChecks).toBe(1);
    } else {
      expect(result.content).not.toEqual([
        { type: 'text', text: 'Tool arguments exceed the maximum of 10000 elements.' },
      ]);
      expect(databaseChecks).toBe(1);
    }
  } finally {
    await client.close();
    await server.close();
    rmSync(path, { recursive: true, force: true });
  }
}

test('MCP rejects an oversized array before any database access', async () => {
  await exercise({ data: Array(10_000).fill(null) }, true);
});

test('MCP rejects an oversized object before any database access', async () => {
  const data = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`key${i}`, null]));
  await exercise({ data }, true);
});

test('MCP counts members across nested collections', async () => {
  await exercise(
    { data: Array.from({ length: 100 }, () => ({ values: Array(100).fill(null) })) },
    true
  );
});

test('MCP rejects deeply nested arguments without recursion', async () => {
  let data: Record<string, unknown> = {};
  for (let i = 0; i < 10_001; i++) data = { nested: data };
  await exercise(data, true);
});

test('MCP accepts arguments exactly at the 10000-member boundary', async () => {
  await exercise({ data: Array(9_999).fill(null) }, false);
});

test('MCP ordinary arguments still reach the database availability check', async () => {
  await exercise({}, false);
});
