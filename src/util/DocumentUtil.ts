import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import type { RawChunk, RetrievedChunk, DocumentChunk } from '../schemas/types';
import type { DocumentStore, HybridSearchDiagnostics } from '../stores/DocumentStore';
import { TemporalUtil } from './TemporalUtil';

export type RetrievalDiagnostics = {
  // Hybrid search stage
  hybridSearch: HybridSearchDiagnostics;
  // Pipeline stages
  afterRelevanceFilter: number;
  afterDedup: number;
  afterBudget: number;
  // Quality signals
  topChunkDistance: number;
  scoreSpread: number; // difference between top and bottom chunk distances
  uniqueDocuments: number;
  temporalFilterApplied: boolean;
  queryYear: number | null;
};

// Budget constraints for document retrieval
const DEFAULT_BUDGET = {
  maxContextTokens: 2500,
  maxChunks: 8,
  maxPerDoc: 4,
  maxChunkTokens: 700,
};

export type BudgetOptions = {
  maxContextTokens?: number;
  maxChunks?: number;
  maxPerDoc?: number;
  maxChunkTokens?: number;
};

export const DocumentUtil = {
  estimateTokens(text: string) {
    return Math.ceil(text.length / 4);
  },

  cosineSimilarity(a: number[], b: number[]) {
    let dot = 0,
      na = 0,
      nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) {
      return 0;
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  },

  removeDuplicateChunks(chunks: RetrievedChunk[], threshold = 0.92) {
    const kept: RetrievedChunk[] = [];

    for (const c of chunks) {
      if (!c.embedding?.length) {
        kept.push(c);
        continue;
      }

      let isDup = false;
      for (const k of kept) {
        if (!k.embedding?.length) continue;

        const sim = this.cosineSimilarity(c.embedding, k.embedding);
        if (sim >= threshold) {
          isDup = true;
          break;
        }
      }

      if (!isDup) kept.push(c);
    }

    return kept;
  },

  async chunkText(
    documentId: string,
    text: string,
    opts?: { maxTokensPerChunk?: number; overlapTokens?: number }
  ): Promise<RawChunk[]> {
    const maxTokens = opts?.maxTokensPerChunk ?? 600;
    const overlapTokens = opts?.overlapTokens ?? 200;

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: maxTokens,
      chunkOverlap: overlapTokens,
      lengthFunction: (t) => Math.ceil(t.length / 4),
    });

    const chunks = await splitter.splitText(text);

    return chunks
      .map((content, index) => ({
        chunk_index: index,
        content: content.trim(),
        token_count: Math.ceil(content.length / 4),
        metadata: {},
      }))
      .filter((c) => c.content.length > 0);
  },
  passRelevanceRules(chunk: RetrievedChunk) {
    const text = chunk.content?.trim() ?? '';
    if (text.length < 30) return false;

    const uploadedAtRaw = (chunk.metadata?.uploadedAt as string | undefined) ?? chunk.created_at;

    const uploadedAt = new Date(uploadedAtRaw);
    if (Number.isNaN(uploadedAt.getTime())) return false;

    const daysSinceUpload = (Date.now() - uploadedAt.getTime()) / 86400000;

    const maxAgeDays = 360;
    if (daysSinceUpload > maxAgeDays) return false;

    const fileType = chunk.metadata?.fileType as string | undefined;
    if (fileType && !['pdf', 'txt', 'md', 'docx'].includes(fileType)) return false;

    return true;
  },

  /**
   * Apply budget constraints to retrieved chunks.
   * Chunks should be pre-sorted by relevance (most relevant first).
   *
   * Constraints applied in order:
   * 1. Filter chunks exceeding maxChunkTokens
   * 2. Limit chunks per document to maxPerDoc
   * 3. Limit total chunks to maxChunks
   * 4. Limit total context tokens to maxContextTokens
   */
  applyBudget(chunks: DocumentChunk[], options?: BudgetOptions): DocumentChunk[] {
    const {
      maxContextTokens = DEFAULT_BUDGET.maxContextTokens,
      maxChunks = DEFAULT_BUDGET.maxChunks,
      maxPerDoc = DEFAULT_BUDGET.maxPerDoc,
      maxChunkTokens = DEFAULT_BUDGET.maxChunkTokens,
    } = options ?? {};

    const tokenCount = (c: DocumentChunk) => {
      const t = c.token_count;
      if (typeof t === 'number' && t > 0) return t;
      // ~4 chars/token heuristic
      return Math.ceil((c.content?.length ?? 0) / 4);
    };

    // 1) Filter *softly*: keep the first chunk even if it’s large
    const validChunks: DocumentChunk[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const t = tokenCount(c);
      if (t <= maxChunkTokens || i === 0) validChunks.push(c);
    }

    // 2) Limit chunks per document
    const docCounts = new Map<string, number>();
    const perDocFiltered: DocumentChunk[] = [];

    for (const chunk of validChunks) {
      const docId = chunk.document_id ?? '__unknown__';
      const count = docCounts.get(docId) ?? 0;
      if (count < maxPerDoc) {
        perDocFiltered.push(chunk);
        docCounts.set(docId, count + 1);
      }
    }

    // 3 & 4) Limit total chunks and total tokens
    const selected: DocumentChunk[] = [];
    let totalTokens = 0;

    for (const chunk of perDocFiltered) {
      if (selected.length >= maxChunks) break;

      const t = tokenCount(chunk);
      if (totalTokens + t > maxContextTokens) continue; // <-- key fix

      selected.push(chunk);
      totalTokens += t;
    }

    return selected;
  },
  calculateMinDAndRange(chunks: DocumentChunk[]) {
    // Confidence is computed by calculating which chunk has the smallest cosine distance from the embedded query
    const distances = chunks.map((c) => c.distance);
    const minD = Math.min(...distances);
    const maxD = Math.max(...distances);
    const range = Math.max(1e-9, maxD - minD);

    return {
      range,
      minD,
    };
  },
  /**
   * Retrieve relevant chunks from the document store.
   *
   * Pipeline:
   * 1. Hybrid search (embedding similarity + keyword matching + temporal filter)
   * 2. Filter by relevance rules
   * 3. Remove near-duplicate chunks
   * 4. Apply budget constraints
   *
   * Returns chunks and diagnostics for observability.
   */
  async retrieveRelevantChunks(
    store: DocumentStore,
    input: {
      queryEmbedding?: number[];
      user_id: string;
      topK?: number;
      userQuery: string;
    },
    budgetOptions?: BudgetOptions
  ): Promise<{ chunks: DocumentChunk[]; diagnostics: RetrievalDiagnostics }> {
    const topK = input.topK ?? 20;

    // Extract year from query for temporal filtering
    const filterYear = TemporalUtil.extractQueryYear(input.userQuery);

    // 1. Hybrid search: embedding similarity + keyword matching
    const { chunks: rawChunks, diagnostics: hybridDiagnostics } = await store.hybridSearch({
      query: input.userQuery,
      queryEmbedding: input.queryEmbedding,
      user_id: input.user_id,
      topK,
      filterYear: filterYear ?? undefined,
    });

    if (rawChunks.length === 0) {
      return {
        chunks: [],
        diagnostics: {
          hybridSearch: hybridDiagnostics,
          afterRelevanceFilter: 0,
          afterDedup: 0,
          afterBudget: 0,
          topChunkDistance: -1,
          scoreSpread: 0,
          uniqueDocuments: 0,
          temporalFilterApplied: filterYear !== null,
          queryYear: filterYear,
        },
      };
    }

    // Extended type to carry distance and document info through pipeline
    type ChunkWithDistance = RetrievedChunk & {
      distance: number;
      document_title?: string;
      document_source?: string;
    };

    const extendedChunks: ChunkWithDistance[] = rawChunks.map((chunk) => ({
      id: chunk.id,
      document_id: chunk.document_id,
      document_title: chunk.document_title,
      document_source: chunk.document_source,
      chunk_index: chunk.chunk_index,
      content: chunk.content,
      token_count: chunk.token_count,
      metadata: chunk.metadata,
      created_at: chunk.created_at,
      embedding: chunk.embedding,
      distance: chunk.distance,
    }));

    // 2. Filter by relevance rules
    const relevant = extendedChunks.filter((chunk) => this.passRelevanceRules(chunk));

    // 3. Remove near-duplicates (cast to RetrievedChunk for the function, then back)
    const deduped = this.removeDuplicateChunks(relevant) as ChunkWithDistance[];

    // 4. Convert to DocumentChunk format for budget application
    const documentChunks: DocumentChunk[] = deduped.map((chunk) => ({
      id: chunk.id,
      document_id: chunk.document_id,
      document_title: chunk.document_title,
      document_source: chunk.document_source,
      chunk_index: chunk.chunk_index,
      content: chunk.content,
      token_count: chunk.token_count,
      metadata: chunk.metadata,
      created_at: chunk.created_at,
      embedding: chunk.embedding,
      distance: chunk.distance,
      // Scaled confidence: distance 0.3→0.85, 0.5→0.75, 0.7→0.65
      confidence: Math.max(0, 1 - chunk.distance * 0.5),
    }));

    // 5. Apply budget constraints (keeps first N = most relevant)
    const finalChunks = this.applyBudget(documentChunks, budgetOptions);

    // Calculate diagnostics
    const topChunkDistance = finalChunks.length > 0 ? finalChunks[0].distance : -1;
    const bottomChunkDistance =
      finalChunks.length > 0 ? finalChunks[finalChunks.length - 1].distance : -1;
    const uniqueDocIds = new Set(finalChunks.map((c) => c.document_id));

    const diagnostics: RetrievalDiagnostics = {
      hybridSearch: hybridDiagnostics,
      afterRelevanceFilter: relevant.length,
      afterDedup: deduped.length,
      afterBudget: finalChunks.length,
      topChunkDistance,
      scoreSpread: bottomChunkDistance - topChunkDistance,
      uniqueDocuments: uniqueDocIds.size,
      temporalFilterApplied: filterYear !== null,
      queryYear: filterYear,
    };

    return { chunks: finalChunks, diagnostics };
  },
};
