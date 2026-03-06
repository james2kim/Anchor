import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawChunk } from '../schemas/types';

// ---- Mocks (hoisted so vi.mock factories can reference them) ----

const { mockEmbedBatch, mockChunkText, mockExtractTemporalRange } = vi.hoisted(() => ({
  mockEmbedBatch: vi.fn(),
  mockChunkText: vi.fn(),
  mockExtractTemporalRange: vi.fn().mockReturnValue({ start_year: null, end_year: null }),
}));

vi.mock('../services/EmbeddingService', () => ({
  defaultEmbedding: { embedBatch: mockEmbedBatch },
}));

vi.mock('../util/DocumentUtil', () => ({
  DocumentUtil: { chunkText: mockChunkText },
}));

vi.mock('../util/TemporalUtil', () => ({
  TemporalUtil: { extractTemporalRange: mockExtractTemporalRange },
}));

import { ingestDocument } from '../ingest/ingestDocument';

// ---- Helpers ----

function makeChunks(count: number): RawChunk[] {
  return Array.from({ length: count }, (_, i) => ({
    chunk_index: i,
    content: `chunk-${i}-content`,
    token_count: 50,
    metadata: {},
  }));
}

function fakeEmbedding(dim = 3): number[] {
  return Array.from({ length: dim }, (_, i) => i * 0.1);
}

function createFakeKnex() {
  return {
    transaction: vi.fn(async (cb: (trx: unknown) => Promise<unknown>) => cb('fake-trx')),
  } as any;
}

function createFakeStores() {
  return {
    documents: {
      upsertDocument: vi.fn().mockResolvedValue({ id: 'doc-123' }),
      upsertChunks: vi.fn().mockResolvedValue(undefined),
    },
  } as any;
}

const INPUT = { source: 'test.pdf', title: 'Test Doc', text: 'full text' };
const USER_ID = 'user-1';

describe('ingestDocument batching', () => {
  beforeEach(() => {
    mockEmbedBatch.mockReset();
    mockChunkText.mockReset();
    mockExtractTemporalRange.mockReset();
    mockExtractTemporalRange.mockReturnValue({ start_year: null, end_year: null });
  });

  it('calls embedBatch once for a small doc (10 chunks, batch size 64)', async () => {
    const chunks = makeChunks(10);
    mockChunkText.mockResolvedValue(chunks);
    mockEmbedBatch.mockResolvedValue(chunks.map(() => fakeEmbedding()));

    const knex = createFakeKnex();
    const stores = createFakeStores();

    const result = await ingestDocument(knex, stores, INPUT, USER_ID);

    expect(result.chunkCount).toBe(10);
    expect(mockEmbedBatch).toHaveBeenCalledTimes(1);
    expect(mockEmbedBatch).toHaveBeenCalledWith(
      chunks.map((c) => c.content),
      'document'
    );
  });

  it('calls embedBatch 4 times for a large doc (200 chunks, batch size 64)', async () => {
    const chunks = makeChunks(200);
    mockChunkText.mockResolvedValue(chunks);

    // Return correct number of embeddings per batch call
    mockEmbedBatch.mockImplementation(async (texts: string[]) =>
      texts.map(() => fakeEmbedding())
    );

    const knex = createFakeKnex();
    const stores = createFakeStores();

    const result = await ingestDocument(knex, stores, INPUT, USER_ID);

    expect(result.chunkCount).toBe(200);
    expect(mockEmbedBatch).toHaveBeenCalledTimes(4);

    // Verify batch sizes: 64, 64, 64, 8
    const batchSizes = mockEmbedBatch.mock.calls.map((call: unknown[]) => (call[0] as string[]).length);
    expect(batchSizes).toEqual([64, 64, 64, 8]);
  });

  it('makes no embedBatch calls and returns chunkCount 0 for zero chunks', async () => {
    mockChunkText.mockResolvedValue([]);

    const knex = createFakeKnex();
    const stores = createFakeStores();

    const result = await ingestDocument(knex, stores, INPUT, USER_ID);

    expect(result.chunkCount).toBe(0);
    expect(mockEmbedBatch).not.toHaveBeenCalled();
  });

  it('passes correct embeddings mapped to chunks into upsertChunks', async () => {
    const chunks = makeChunks(3);
    mockChunkText.mockResolvedValue(chunks);

    const embeddings = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    mockEmbedBatch.mockResolvedValue(embeddings);

    const knex = createFakeKnex();
    const stores = createFakeStores();

    await ingestDocument(knex, stores, INPUT, USER_ID);

    expect(stores.documents.upsertChunks).toHaveBeenCalledOnce();
    const call = stores.documents.upsertChunks.mock.calls[0];
    const upsertInput = call[0] as { documentId: string; chunks: Array<{ embedding: number[] }> };

    expect(upsertInput.documentId).toBe('doc-123');
    expect(upsertInput.chunks).toHaveLength(3);
    expect(upsertInput.chunks[0].embedding).toEqual([1, 0, 0]);
    expect(upsertInput.chunks[1].embedding).toEqual([0, 1, 0]);
    expect(upsertInput.chunks[2].embedding).toEqual([0, 0, 1]);
  });

  it('runs temporal extraction for every chunk', async () => {
    const chunks = makeChunks(5);
    mockChunkText.mockResolvedValue(chunks);
    mockEmbedBatch.mockResolvedValue(chunks.map(() => fakeEmbedding()));
    mockExtractTemporalRange.mockReturnValue({ start_year: 2020, end_year: 2024 });

    const knex = createFakeKnex();
    const stores = createFakeStores();

    await ingestDocument(knex, stores, INPUT, USER_ID);

    expect(mockExtractTemporalRange).toHaveBeenCalledTimes(5);
    for (const chunk of chunks) {
      expect(mockExtractTemporalRange).toHaveBeenCalledWith(chunk.content);
    }

    // Verify temporal data flows into upsertChunks
    const upsertInput = stores.documents.upsertChunks.mock.calls[0][0] as {
      chunks: Array<{ start_year: number | null; end_year: number | null }>;
    };
    expect(upsertInput.chunks[0].start_year).toBe(2020);
    expect(upsertInput.chunks[0].end_year).toBe(2024);
  });
});
