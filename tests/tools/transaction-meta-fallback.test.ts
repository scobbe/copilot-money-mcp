import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { CopilotDatabase } from '../../src/core/database.js';
import { LiveCopilotDatabase } from '../../src/core/live-database.js';
import type { TransactionNode } from '../../src/core/graphql/queries/transactions.js';
import type { Transaction } from '../../src/models/transaction.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import { createMockGraphQLClient } from '../helpers/mock-graphql.js';

function node(id: string): TransactionNode {
  return {
    id,
    accountId: `live-account-${id}`,
    itemId: `live-item-${id}`,
    categoryId: null,
    recurringId: null,
    parentId: null,
    isReviewed: false,
    isPending: false,
    amount: 10,
    date: '2026-01-01',
    name: 'Fixture',
    type: 'REGULAR',
    userNotes: null,
    tipAmount: null,
    suggestedCategoryIds: [],
    isoCurrencyCode: 'USD',
    createdAt: 0,
    tags: [],
    goal: null,
  };
}

function setup(local: Transaction[] = [], rows: TransactionNode[] = []) {
  const db = new CopilotDatabase('/nonexistent');
  spyOn(db, 'getAllTransactions').mockResolvedValue(local);
  spyOn(db, 'patchCachedTransaction').mockImplementation(() => false);
  const client = createMockGraphQLClient({
    EditTransaction: {
      editTransaction: {
        transaction: {
          id: 'fixture',
          name: 'Fixture',
          categoryId: '',
          userNotes: null,
          isReviewed: true,
          type: 'REGULAR',
          tags: [],
        },
      },
    },
  });
  const live = new LiveCopilotDatabase(client, db);
  const fetch = spyOn(live, 'getTransactions').mockResolvedValue({
    rows,
    oldest_fetched_at: 0,
    newest_fetched_at: 0,
    hit: false,
  });
  return { client, db, fetch, tools: new CopilotMoneyTools(db, client, live) };
}

const originalWindow = process.env.COPILOT_WRITE_RESOLVE_WINDOW_MONTHS;
afterEach(() => {
  if (originalWindow === undefined) delete process.env.COPILOT_WRITE_RESOLVE_WINDOW_MONTHS;
  else process.env.COPILOT_WRITE_RESOLVE_WINDOW_MONTHS = originalWindow;
});

describe('transaction metadata fallback orchestration (no live API writes)', () => {
  test('complete local metadata avoids a live fetch', async () => {
    const { tools, fetch, client } = setup([
      {
        transaction_id: 'cached',
        amount: 10,
        date: '2026-01-01',
        account_id: 'local-account',
        item_id: 'local-item',
      },
    ]);
    await tools.updateTransaction({ transaction_id: 'cached', reviewed: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(client._calls[0].variables).toMatchObject({
      id: 'cached',
      accountId: 'local-account',
      itemId: 'local-item',
    });
  });

  test('missing or incomplete local metadata uses matching live account and item', async () => {
    for (const local of [[], [{ transaction_id: 'older', amount: 10, date: '2026-01-01' }]]) {
      const { tools, fetch, client } = setup(local, [node('older')]);
      await tools.updateTransaction({ transaction_id: 'older', reviewed: true });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(client._calls[0].variables).toMatchObject({
        id: 'older',
        accountId: 'live-account-older',
        itemId: 'live-item-older',
        input: { isReviewed: true },
      });
    }
  });

  test('one live fetch resolves a mixed batch while preserving cached metadata', async () => {
    const { tools, fetch, client } = setup(
      [
        {
          transaction_id: 'cached',
          amount: 10,
          date: '2026-01-01',
          account_id: 'local-account',
          item_id: 'local-item',
        },
      ],
      [node('cached'), node('older'), node('another')]
    );
    const result = await tools.reviewTransactions({
      transaction_ids: ['cached', 'older', 'another'],
    });
    expect(result.reviewed_count).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(client._calls.map((c) => c.variables)).toEqual([
      {
        id: 'cached',
        accountId: 'local-account',
        itemId: 'local-item',
        input: { isReviewed: true },
      },
      {
        id: 'older',
        accountId: 'live-account-older',
        itemId: 'live-item-older',
        input: { isReviewed: true },
      },
      {
        id: 'another',
        accountId: 'live-account-another',
        itemId: 'live-item-another',
        input: { isReviewed: true },
      },
    ]);
  });

  test('an unresolved batch ID prevents every mutation', async () => {
    const { tools, client } = setup([], [node('found')]);
    await expect(
      tools.reviewTransactions({ transaction_ids: ['found', 'missing'] })
    ).rejects.toThrow('Transactions not found: missing');
    expect(client._calls).toHaveLength(0);
  });

  test('live metadata missing an account or item cannot authorize a mutation', async () => {
    for (const row of [
      { ...node('older'), accountId: '' },
      { ...node('older'), itemId: '' },
    ]) {
      const { tools, client } = setup([], [row]);
      await expect(
        tools.updateTransaction({ transaction_id: 'older', reviewed: true })
      ).rejects.toThrow('Transaction not found');
      expect(client._calls).toHaveLength(0);
    }
  });

  test('live fetch errors prevent all mutations', async () => {
    const { tools, fetch, client } = setup();
    fetch.mockRejectedValue(new Error('Read failed'));
    await expect(tools.reviewTransactions({ transaction_ids: ['older'] })).rejects.toThrow(
      'Read failed'
    );
    expect(client._calls).toHaveLength(0);
  });

  test('invalid window configuration fails before fetching or writing', async () => {
    for (const value of ['0', '-1', '1.5', '121', 'Infinity', 'invalid']) {
      process.env.COPILOT_WRITE_RESOLVE_WINDOW_MONTHS = value;
      const { tools, fetch, client } = setup();
      await expect(
        tools.updateTransaction({ transaction_id: 'older', reviewed: true })
      ).rejects.toThrow('must be an integer from 1 to 120');
      expect(fetch).not.toHaveBeenCalled();
      expect(client._calls).toHaveLength(0);
    }
  });
});
