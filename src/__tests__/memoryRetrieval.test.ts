import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MemoryUtil } from '../util/MemoryUtil';
import { db } from '../db/knex';
import { TEST_MEMORIES, TEST_MEMORY_QUERIES, TEST_USER_ID } from './fixtures/testMemories';
import { MemoryStore } from '../stores/MemoryStore';
import { defaultEmbedding } from '../services/EmbeddingService';
import type { Memory } from '../schemas/types';

/**
 * Memory Retrieval Quality Evaluation
 *
 * Follows similar pattern to document retrieval tests.
 * Tests the full pipeline: embedding → search → filter → rank → budget.
 */

const MRR_THRESHOLD = 0.6;
const RECALL_K = 5;
const RECALL_THRESHOLD = 0.6;

const memIdToContent = new Map(TEST_MEMORIES.map((m) => [m.id, m.content]));

interface RetrievedMemory {
  id: string;
  content: string;
  type: Memory['type'];
  confidence: number;
}

function isRelevant(memory: RetrievedMemory, relevantMemoryIds: string[]): boolean {
  const relevantContents = relevantMemoryIds.map((id) => memIdToContent.get(id)).filter(Boolean);
  return relevantContents.includes(memory.content);
}

function calculateRR(memories: RetrievedMemory[], relevantMemoryIds: string[]): number {
  if (relevantMemoryIds.length === 0) {
    return memories.length === 0 ? 1 : 0;
  }
  for (let i = 0; i < memories.length; i++) {
    if (isRelevant(memories[i], relevantMemoryIds)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function calculateRecallAtK(
  memories: RetrievedMemory[],
  relevantMemoryIds: string[],
  k: number
): number {
  if (relevantMemoryIds.length === 0) {
    return memories.length === 0 ? 1 : 0;
  }
  const topK = memories.slice(0, k);
  const relevantContents = new Set(relevantMemoryIds.map((id) => memIdToContent.get(id)));
  const foundCount = topK.filter((m) => relevantContents.has(m.content)).length;
  return foundCount / relevantMemoryIds.length;
}

async function evaluateQuery(testQuery: (typeof TEST_MEMORY_QUERIES)[0]) {
  const result = await MemoryUtil.retrieveRelevantMemories(TEST_USER_ID, testQuery.query, {
    maxResults: 10,
    allowedTypes: testQuery.allowedTypes,
  });

  if (!result.success) {
    return {
      testId: testQuery.id,
      rr: 0,
      recallAtK: 0,
      memories: [],
      error: result.error_message,
    };
  }

  const memories = result.memories as RetrievedMemory[];

  return {
    testId: testQuery.id,
    rr: calculateRR(memories, testQuery.relevantMemoryIds),
    recallAtK: calculateRecallAtK(memories, testQuery.relevantMemoryIds, RECALL_K),
    memories,
  };
}

describe('Memory Retrieval Quality Evaluation', () => {
  beforeAll(async () => {
    // Check if test data exists; seed automatically if missing
    const count = await db('memories').where('user_id', TEST_USER_ID).count('* as count').first();
    if (!count || Number(count.count) === 0) {
      console.log('[memoryRetrieval] Seeding test memories...');
      const now = Date.now();

      for (const mem of TEST_MEMORIES) {
        const createdAt = new Date(now - mem.daysAgo * 86400000);
        const embedding = await defaultEmbedding.embedText(mem.content, 'document');

        await MemoryStore.addMemory(
          {
            content: mem.content,
            type: mem.type,
            confidence: mem.confidence,
            user_id: TEST_USER_ID,
          },
          embedding
        );

        await db('memories')
          .where('user_id', TEST_USER_ID)
          .where('content', mem.content)
          .update({ created_at: createdAt });
      }

      console.log(`[memoryRetrieval] Seeded ${TEST_MEMORIES.length} test memories.`);
    }
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
  });

  describe('Aggregate Metrics', () => {
    it(`MRR should be >= ${MRR_THRESHOLD}`, async () => {
      const queriesWithRelevant = TEST_MEMORY_QUERIES.filter((q) => q.relevantMemoryIds.length > 0);
      const results = await Promise.all(queriesWithRelevant.map(evaluateQuery));
      const mrr = results.reduce((sum, r) => sum + r.rr, 0) / results.length;

      console.log(`Memory MRR: ${mrr.toFixed(3)} (threshold: ${MRR_THRESHOLD})`);
      expect(mrr).toBeGreaterThanOrEqual(MRR_THRESHOLD);
    });

    it(`Recall@${RECALL_K} should be >= ${RECALL_THRESHOLD}`, async () => {
      const queriesWithRelevant = TEST_MEMORY_QUERIES.filter((q) => q.relevantMemoryIds.length > 0);
      const results = await Promise.all(queriesWithRelevant.map(evaluateQuery));
      const meanRecall = results.reduce((sum, r) => sum + r.recallAtK, 0) / results.length;

      console.log(
        `Memory Recall@${RECALL_K}: ${meanRecall.toFixed(3)} (threshold: ${RECALL_THRESHOLD})`
      );
      expect(meanRecall).toBeGreaterThanOrEqual(RECALL_THRESHOLD);
    });
  });

  describe('Type Filtering', () => {
    it('should filter by allowed types (preferences only)', async () => {
      const result = await MemoryUtil.retrieveRelevantMemories(
        TEST_USER_ID,
        'What are my preferences?',
        { maxResults: 10, allowedTypes: ['preference'] }
      );

      expect(result.success).toBe(true);
      if (result.success) {
        result.memories.forEach((m) => {
          expect(m.type).toBe('preference');
        });
      }
    });

    it('should filter by allowed types (facts only)', async () => {
      const result = await MemoryUtil.retrieveRelevantMemories(
        TEST_USER_ID,
        'Tell me facts about me',
        { maxResults: 10, allowedTypes: ['fact'] }
      );

      expect(result.success).toBe(true);
      if (result.success) {
        result.memories.forEach((m) => {
          expect(m.type).toBe('fact');
        });
      }
    });

    it('should filter by multiple allowed types', async () => {
      const result = await MemoryUtil.retrieveRelevantMemories(TEST_USER_ID, 'What do I know?', {
        maxResults: 10,
        allowedTypes: ['fact', 'preference'],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        result.memories.forEach((m) => {
          expect(['fact', 'preference']).toContain(m.type);
        });
      }
    });
  });

  describe('Relevance Filtering', () => {
    it('should filter out low confidence memories', async () => {
      const result = await MemoryUtil.retrieveRelevantMemories(TEST_USER_ID, 'quantum computing', {
        maxResults: 10,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // Low confidence memories should be filtered out
        result.memories.forEach((m) => {
          expect(m.confidence).toBeGreaterThanOrEqual(0.6);
        });
      }
    });

    it('should filter out expired memories based on type', async () => {
      const result = await MemoryUtil.retrieveRelevantMemories(
        TEST_USER_ID,
        'goals and decisions',
        { maxResults: 20 }
      );

      expect(result.success).toBe(true);
      if (result.success) {
        // All returned memories should pass relevance rules
        result.memories.forEach((m) => {
          expect(MemoryUtil.passRelevanceRules(m)).toBe(true);
        });
      }
    });
  });

  describe('Budget Constraints', () => {
    it('should respect maxResults limit', async () => {
      const result = await MemoryUtil.retrieveRelevantMemories(
        TEST_USER_ID,
        'Tell me everything about me',
        { maxResults: 3 }
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.memories.length).toBeLessThanOrEqual(3);
      }
    });

    it('should respect maxTokens limit', async () => {
      const result = await MemoryUtil.retrieveRelevantMemories(TEST_USER_ID, 'Tell me everything', {
        maxResults: 10,
        maxTokens: 200,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const totalTokens = result.memories.reduce(
          (sum, m) => sum + MemoryUtil.estimateTokens(m.content),
          0
        );
        expect(totalTokens).toBeLessThanOrEqual(200);
      }
    });
  });

  describe('Query Categories', () => {
    it('preference queries should retrieve preferences', async () => {
      const queries = TEST_MEMORY_QUERIES.filter((q) => q.id.startsWith('pref-'));
      const results = await Promise.all(queries.map(evaluateQuery));
      const avgRR = results.reduce((s, r) => s + r.rr, 0) / results.length;

      console.log(`Preference query avg RR: ${avgRR.toFixed(3)}`);
      expect(avgRR).toBeGreaterThan(0);
    });

    it('fact queries should retrieve facts', async () => {
      const queries = TEST_MEMORY_QUERIES.filter((q) => q.id.startsWith('fact-'));
      const results = await Promise.all(queries.map(evaluateQuery));
      const avgRR = results.reduce((s, r) => s + r.rr, 0) / results.length;

      console.log(`Fact query avg RR: ${avgRR.toFixed(3)}`);
      expect(avgRR).toBeGreaterThan(0);
    });

    it('cross-type queries should retrieve from multiple types', async () => {
      const queries = TEST_MEMORY_QUERIES.filter((q) => q.id.startsWith('cross-'));
      const results = await Promise.all(queries.map(evaluateQuery));

      // At least some cross-type queries should return memories
      const hasResults = results.some((r) => r.memories.length > 0);
      expect(hasResults).toBe(true);
    });
  });

  describe('Negative Cases', () => {
    it('should not retrieve low confidence memories', async () => {
      const query = TEST_MEMORY_QUERIES.find((q) => q.id === 'filter-low-confidence');
      if (!query) return;

      const result = await evaluateQuery(query);

      // Should not find the low confidence memory
      const lowConfContent = memIdToContent.get('low-conf-uncertain');
      const foundLowConf = result.memories.some((m) => m.content === lowConfContent);
      expect(foundLowConf).toBe(false);
    });

    it('should not retrieve expired memories', async () => {
      const query = TEST_MEMORY_QUERIES.find((q) => q.id === 'filter-expired-decision');
      if (!query) return;

      const result = await evaluateQuery(query);

      // Should not find the expired decision memory
      const expiredContent = memIdToContent.get('decision-expired');
      const foundExpired = result.memories.some((m) => m.content === expiredContent);
      expect(foundExpired).toBe(false);
    });
  });
});
