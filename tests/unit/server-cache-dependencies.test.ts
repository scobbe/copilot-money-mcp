import { describe, expect, spyOn, test } from 'bun:test';
import { CopilotMoneyServer } from '../../src/server.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import { ALL_TOOL_DEFS } from '../../src/tools/registry/index.js';

describe('server routing without a desktop cache', () => {
  // No provider requests occur: this tests the dispatch boundary, with every
  // registered API handler replaced by a sentinel and restored after its call.
  for (const def of ALL_TOOL_DEFS) {
    test(`${def.name} has the correct cache dependency`, async () => {
      const server = new CopilotMoneyServer(
        '/nonexistent/copilot-cache-dependency-test',
        undefined,
        true,
        true,
        {} as GraphQLClient
      );
      const handler = spyOn(def, 'handler').mockResolvedValue({ dispatched: true });
      try {
        const result = await server.handleCallTool(def.name, {});
        if (def.requiresLiveReads || !def.readOnly) {
          expect(result.isError).not.toBe(true);
          expect(handler).toHaveBeenCalledTimes(1);
          expect(JSON.parse(String(result.content[0]?.text))).toEqual({ dispatched: true });
        } else {
          expect(result.isError).toBe(true);
          expect(handler).not.toHaveBeenCalled();
          expect(result.content[0]?.text).toContain('Database not available');
        }
      } finally {
        handler.mockRestore();
      }
    });
  }

  test('a missing cache does not mask an unknown tool', async () => {
    const server = new CopilotMoneyServer('/nonexistent/copilot-cache-dependency-test');
    const result = await server.handleCallTool('not_a_registered_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('Unknown tool: not_a_registered_tool');
  });
});
