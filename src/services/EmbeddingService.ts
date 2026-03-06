import { VoyageAIClient } from 'voyageai';
import dotenv from 'dotenv';
import { withRetry } from '../util/RetryUtil';
dotenv.config({ path: '.env.local' });

export class EmbeddingService {
  private client: VoyageAIClient;
  private model: string;

  constructor() {
    const apiKey = process.env.VOYAGE_API_KEY;
    if (!apiKey) {
      throw new Error('Missing required environment variable: VOYAGE_API_KEY');
    }
    this.client = new VoyageAIClient({ apiKey });
    this.model = 'voyage-3.5-lite';
  }
  normalizeVector(vec: number[]): number[] {
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (norm === 0) return vec;
    return vec.map((v) => v / norm);
  }

  async embedText(text: string, inputType: 'document' | 'query' = 'document'): Promise<number[]> {
    const response = await withRetry(
      () => this.client.embed({ input: text, model: this.model, inputType: inputType }),
      { label: 'embedText' }
    );
    const embedding = response.data?.[0]?.embedding;
    if (!embedding) {
      throw new Error('Embedding failed');
    }
    return embedding;
  }

  /**
   * Embed multiple texts in a single API call.
   * Voyage AI supports batching natively — far fewer API calls than one-by-one.
   */
  async embedBatch(
    texts: string[],
    inputType: 'document' | 'query' = 'document'
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await withRetry(
      () => this.client.embed({ input: texts, model: this.model, inputType }),
      { label: 'embedBatch', maxAttempts: 5, baseDelayMs: 2000 }
    );

    const embeddings = response.data?.map((d) => d.embedding);
    if (!embeddings || embeddings.length !== texts.length) {
      throw new Error(`Embedding batch failed: expected ${texts.length} results, got ${embeddings?.length ?? 0}`);
    }
    return embeddings as number[][];
  }
}

// Default instance for simple usage
export const defaultEmbedding = new EmbeddingService();
