import type { Knex } from 'knex';
import { DocumentStore } from '../stores/DocumentStore';
import type { IngestDocument, RawChunk } from '../schemas/types';
import { defaultEmbedding } from '../services/EmbeddingService';
import { DocumentUtil } from '../util/DocumentUtil';
import { TemporalUtil } from '../util/TemporalUtil';

// Voyage AI recommends up to 128 inputs per batch call.
// We use 64 to stay well under RPM limits with retries.
const EMBED_BATCH_SIZE = 64;
const BATCH_DELAY_MS = 500; // pause between batches to stay under RPM

export async function ingestDocument(
  knex: Knex,
  stores: { documents: DocumentStore },
  input: IngestDocument,
  user_id: string
): Promise<{ documentId: string; chunkCount: number }> {
  return await knex.transaction(async (trx) => {
    const { id: documentId } = await stores.documents.upsertDocument(
      {
        source: input.source,
        title: input.title,
        metadata: input.metadata,
        user_id,
      },
      trx
    );

    const rawChunks: RawChunk[] = await DocumentUtil.chunkText(documentId, input.text);

    // Embed in batches to avoid rate limits
    const allEmbeddings: number[][] = [];
    for (let i = 0; i < rawChunks.length; i += EMBED_BATCH_SIZE) {
      const batch = rawChunks.slice(i, i + EMBED_BATCH_SIZE);
      const texts = batch.map((c) => c.content);

      console.log(
        `[ingest] Embedding batch ${Math.floor(i / EMBED_BATCH_SIZE) + 1}/${Math.ceil(rawChunks.length / EMBED_BATCH_SIZE)} (${texts.length} chunks)`
      );

      const embeddings = await defaultEmbedding.embedBatch(texts, 'document');
      allEmbeddings.push(...embeddings);

      // Pause between batches to stay under RPM limits
      if (i + EMBED_BATCH_SIZE < rawChunks.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    const embeddedChunks = rawChunks.map((c, idx) => {
      const temporal = TemporalUtil.extractTemporalRange(c.content);
      return {
        chunk_index: c.chunk_index,
        content: c.content,
        token_count: c.token_count,
        metadata: c.metadata ?? {},
        embedding: allEmbeddings[idx],
        start_year: temporal.start_year,
        end_year: temporal.end_year,
      };
    });

    await stores.documents.upsertChunks({ documentId, chunks: embeddedChunks, user_id }, trx);

    return { documentId, chunkCount: embeddedChunks.length };
  });
}
