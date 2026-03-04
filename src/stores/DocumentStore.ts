import type { Knex } from 'knex';
import { EmbeddingUtil } from '../util/EmbeddingUtil';

export class DocumentStore {
  constructor(
    private knex: Knex,
    private embedDim: number
  ) {}

  async upsertDocument(
    input: { user_id: string; source: string; title?: string; metadata?: Record<string, unknown> },
    trx?: Knex.Transaction
  ) {
    const k = trx ?? this.knex;

    const rows = await k('documents')
      .insert({
        metadata: input.metadata ?? {},
        title: input.title ?? null,
        source: input.source,
        user_id: input.user_id,
      })
      .onConflict(['user_id', 'source'])
      .merge({
        title: input.title ?? null,
        metadata: input.metadata ?? {},
        updated_at: k.fn.now(),
      })
      .returning(['id']);

    return {
      id: rows[0].id,
    };
  }

  async listChunksBySimilarity(
    input: {
      topK: number;
      queryEmbedding: number[];
      user_id: string;
      filterYear?: number; // Optional temporal filter
    },
    trx?: Knex.Transaction
  ) {
    const k = trx ?? this.knex;
    const vectorLiteral = EmbeddingUtil.toPgVectorLiteral(input.queryEmbedding);

    let query = k('chunks')
      .join('documents', 'chunks.document_id', 'documents.id')
      .select([
        'chunks.id',
        'chunks.document_id',
        'chunks.chunk_index',
        'chunks.content',
        'chunks.token_count',
        'chunks.metadata',
        'chunks.embedding',
        'chunks.created_at',
        'chunks.start_year',
        'chunks.end_year',
        'documents.title as document_title',
        'documents.source as document_source',
      ])
      .select(k.raw('(chunks.embedding <=> ?::vector) AS distance', [vectorLiteral]))
      .whereNotNull('chunks.embedding')
      .andWhere('chunks.user_id', '=', input.user_id);

    // Apply temporal filter if year is specified
    if (input.filterYear) {
      const year = input.filterYear;
      const currentYear = new Date().getFullYear();
      query = query.andWhere(function () {
        this.where('chunks.start_year', '<=', year).andWhere(function () {
          // end_year IS NULL means "Present" (ongoing)
          this.whereNull('chunks.end_year')
            .andWhere('chunks.start_year', '<=', currentYear)
            .orWhere('chunks.end_year', '>=', year);
        });
      });
    }

    query = query.orderByRaw('chunks.embedding <=> ?::vector', [vectorLiteral]).limit(input.topK);

    return await query;
  }

  async upsertChunks(
    input: {
      user_id: string;
      documentId: string;
      chunks: Array<{
        chunk_index: number;
        content: string;
        token_count: number;
        embedding: number[];
        metadata?: Record<string, unknown>;
        start_year?: number | null;
        end_year?: number | null;
      }>;
    },
    trx?: Knex.Transaction
  ): Promise<void> {
    const k = trx ?? this.knex;

    const rows = input.chunks.map((chunk) => ({
      document_id: input.documentId,
      user_id: input.user_id,
      chunk_index: chunk.chunk_index,
      content: chunk.content,
      token_count: chunk.token_count,
      metadata: chunk.metadata ?? {},
      embedding: k.raw('?::vector', [EmbeddingUtil.toPgVectorLiteral(chunk.embedding)]),
      start_year: chunk.start_year ?? null,
      end_year: chunk.end_year ?? null,
      search_vector: k.raw("to_tsvector('english', ?)", [chunk.content]),
      updated_at: k.fn.now(),
    }));

    await k('chunks')
      .insert(rows)
      .onConflict(['document_id', 'chunk_index'])
      .merge({
        content: k.raw('excluded.content'),
        token_count: k.raw('excluded.token_count'),
        metadata: k.raw('excluded.metadata'),
        embedding: k.raw('excluded.embedding'),
        start_year: k.raw('excluded.start_year'),
        end_year: k.raw('excluded.end_year'),
        search_vector: k.raw('excluded.search_vector'),
        updated_at: k.fn.now(),
      });
  }

  /**
   * Full-text keyword search using PostgreSQL tsvector.
   */
  async listChunksByKeyword(
    input: {
      query: string;
      user_id: string;
      topK: number;
      filterYear?: number;
    },
    trx?: Knex.Transaction
  ) {
    const k = trx ?? this.knex;

    // Use plainto_tsquery for safe, injection-free full-text search
    const plainQuery = input.query.trim();

    if (!plainQuery) return [];

    let query = k('chunks')
      .join('documents', 'chunks.document_id', 'documents.id')
      .select([
        'chunks.id',
        'chunks.document_id',
        'chunks.chunk_index',
        'chunks.content',
        'chunks.token_count',
        'chunks.metadata',
        'chunks.embedding',
        'chunks.created_at',
        'chunks.start_year',
        'chunks.end_year',
        'documents.title as document_title',
        'documents.source as document_source',
      ])
      .select(k.raw("ts_rank(chunks.search_vector, plainto_tsquery('english', ?)) AS rank", [plainQuery]))
      .whereRaw("chunks.search_vector @@ plainto_tsquery('english', ?)", [plainQuery])
      .andWhere('chunks.user_id', '=', input.user_id);

    // Apply temporal filter if year is specified
    if (input.filterYear) {
      const year = input.filterYear;
      const currentYear = new Date().getFullYear();
      query = query.andWhere(function () {
        this.where('chunks.start_year', '<=', year).andWhere(function () {
          this.whereNull('chunks.end_year')
            .andWhere('chunks.start_year', '<=', currentYear)
            .orWhere('chunks.end_year', '>=', year);
        });
      });
    }

    query = query.orderBy('rank', 'desc').limit(input.topK);

    return await query;
  }

  /**
   * Hybrid search: combines embedding similarity + keyword matching.
   * Uses Reciprocal Rank Fusion (RRF) to merge results.
   */
  async hybridSearch(
    input: {
      query: string;
      queryEmbedding?: number[];
      user_id: string;
      topK: number;
      filterYear?: number;
    },
    trx?: Knex.Transaction
  ): Promise<{
    chunks: Awaited<ReturnType<DocumentStore['listChunksBySimilarity']>>;
    diagnostics: HybridSearchDiagnostics;
  }> {
    // Run both searches in parallel (skip embedding search if no embedding available)
    const embeddingPromise = input.queryEmbedding
      ? this.listChunksBySimilarity(
          {
            queryEmbedding: input.queryEmbedding,
            user_id: input.user_id,
            topK: input.topK * 2, // Fetch more for fusion
            filterYear: input.filterYear,
          },
          trx
        )
      : Promise.resolve([] as Awaited<ReturnType<DocumentStore['listChunksBySimilarity']>>);

    const [embeddingResults, keywordResults] = await Promise.all([
      embeddingPromise,
      this.listChunksByKeyword(
        {
          query: input.query,
          user_id: input.user_id,
          topK: input.topK * 2,
          filterYear: input.filterYear,
        },
        trx
      ),
    ]);

    // Reciprocal Rank Fusion (RRF)
    // score = sum(1 / (k + rank)) where k=60 is standard
    const k = 60;
    const scores = new Map<string, { chunk: (typeof embeddingResults)[0]; score: number }>();

    // Score embedding results
    embeddingResults.forEach((chunk, rank) => {
      const existing = scores.get(chunk.id) ?? { chunk, score: 0 };
      existing.score += 1 / (k + rank + 1);
      scores.set(chunk.id, existing);
    });

    // Score keyword results (assign default distance when embedding is unavailable)
    keywordResults.forEach((chunk, rank) => {
      const existing = scores.get(chunk.id) ?? { chunk: { ...chunk, distance: chunk.distance ?? 0.75 }, score: 0 };
      existing.score += 1 / (k + rank + 1);
      scores.set(chunk.id, existing);
    });

    // Sort by combined score and return top K
    const sorted = Array.from(scores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, input.topK);

    // Calculate overlap (chunks found by both searches)
    const embeddingIds = new Set(embeddingResults.map((c) => c.id));
    const keywordIds = new Set(keywordResults.map((c) => c.id));
    const overlapCount = [...embeddingIds].filter((id) => keywordIds.has(id)).length;

    const diagnostics: HybridSearchDiagnostics = {
      embeddingCandidates: embeddingResults.length,
      keywordCandidates: keywordResults.length,
      overlapCount,
      fusedCount: sorted.length,
      topEmbeddingDistance: embeddingResults[0]?.distance ?? -1,
      topKeywordRank: keywordResults.length > 0 ? 1 : -1,
    };

    return {
      chunks: sorted.map((s) => s.chunk),
      diagnostics,
    };
  }
}

export type HybridSearchDiagnostics = {
  embeddingCandidates: number;
  keywordCandidates: number;
  overlapCount: number;
  fusedCount: number;
  topEmbeddingDistance: number;
  topKeywordRank: number;
};
