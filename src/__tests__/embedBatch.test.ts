import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks (hoisted so vi.mock factories can reference them) ----

const { mockEmbed, mockWithRetry } = vi.hoisted(() => {
  process.env.VOYAGE_API_KEY = 'test-key';
  return {
    mockEmbed: vi.fn(),
    mockWithRetry: vi.fn(),
  };
});

vi.mock('voyageai', () => ({
  VoyageAIClient: class MockVoyageAIClient {
    embed = mockEmbed;
  },
}));

vi.mock('../util/RetryUtil', () => ({
  withRetry: mockWithRetry,
}));

import { EmbeddingService } from '../services/EmbeddingService';

describe('EmbeddingService.embedBatch', () => {
  let service: EmbeddingService;

  beforeEach(() => {
    mockEmbed.mockReset();
    mockWithRetry.mockReset();
    // Make withRetry pass through to the fn, capturing options
    mockWithRetry.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    service = new EmbeddingService();
  });

  it('returns empty array without calling API for empty input', async () => {
    const result = await service.embedBatch([], 'document');

    expect(result).toEqual([]);
    expect(mockWithRetry).not.toHaveBeenCalled();
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('calls API with single text and returns 1 embedding', async () => {
    const embedding = [0.1, 0.2, 0.3];
    mockEmbed.mockResolvedValue({ data: [{ embedding }] });

    const result = await service.embedBatch(['hello'], 'query');

    expect(result).toEqual([embedding]);
    expect(mockEmbed).toHaveBeenCalledOnce();
    expect(mockEmbed).toHaveBeenCalledWith(
      expect.objectContaining({ input: ['hello'], inputType: 'query' })
    );
  });

  it('calls API with full array for multiple texts and returns correct count', async () => {
    const texts = ['text-a', 'text-b', 'text-c'];
    const embeddings = texts.map((_, i) => [i, i + 1, i + 2]);
    mockEmbed.mockResolvedValue({ data: embeddings.map((e) => ({ embedding: e })) });

    const result = await service.embedBatch(texts, 'document');

    expect(result).toHaveLength(3);
    expect(result).toEqual(embeddings);
    expect(mockEmbed).toHaveBeenCalledWith(
      expect.objectContaining({ input: texts })
    );
  });

  it('throws descriptive error when API returns mismatched count', async () => {
    mockEmbed.mockResolvedValue({
      data: [{ embedding: [0.1] }], // Only 1 result for 3 inputs
    });

    await expect(service.embedBatch(['a', 'b', 'c'], 'document')).rejects.toThrow(
      /expected 3 results, got 1/
    );
  });

  it('calls withRetry with maxAttempts: 5 and baseDelayMs: 2000', async () => {
    mockEmbed.mockResolvedValue({ data: [{ embedding: [0.1] }] });

    await service.embedBatch(['test'], 'document');

    expect(mockWithRetry).toHaveBeenCalledOnce();
    const options = mockWithRetry.mock.calls[0][1];
    expect(options).toMatchObject({ maxAttempts: 5, baseDelayMs: 2000 });
  });
});
