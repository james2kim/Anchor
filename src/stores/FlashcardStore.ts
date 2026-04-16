import type { Knex } from 'knex';
import { db } from '../db/knex';

export interface FlashcardRecord {
  id: string;
  user_id: string;
  title: string;
  flashcard_data: unknown;
  input_data: unknown;
  created_at: string;
}

export interface FlashcardListItem {
  id: string;
  title: string;
  card_count: number;
  created_at: string;
}

class FlashcardStoreClass {
  private knex: Knex;

  constructor(knex: Knex) {
    this.knex = knex;
  }

  async save(
    userId: string,
    title: string,
    flashcardData: unknown,
    inputData: unknown,
    runId?: string
  ): Promise<string> {
    // Idempotency: if a runId is provided and already exists, return the existing record
    if (runId) {
      const existing = await this.knex('flashcards').where({ run_id: runId }).first();
      if (existing) return existing.id;
    }

    const [row] = await this.knex('flashcards')
      .insert({
        user_id: userId,
        title,
        flashcard_data: JSON.stringify(flashcardData),
        input_data: JSON.stringify(inputData),
        run_id: runId ?? null,
      })
      .returning('id');
    return row.id;
  }

  async list(userId: string): Promise<FlashcardListItem[]> {
    const rows = await this.knex('flashcards')
      .select('id', 'title', 'flashcard_data', 'created_at')
      .where('user_id', userId)
      .orderBy('created_at', 'desc');

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      card_count: (r.flashcard_data as any)?.cards?.length ?? 0,
      created_at: r.created_at,
    }));
  }

  async get(flashcardId: string, userId: string): Promise<FlashcardRecord | null> {
    const row = await this.knex('flashcards')
      .where({ id: flashcardId, user_id: userId })
      .first();
    return row ?? null;
  }

  async delete(flashcardId: string, userId: string): Promise<boolean> {
    const deleted = await this.knex('flashcards')
      .where({ id: flashcardId, user_id: userId })
      .del();
    return deleted > 0;
  }
}

export const FlashcardStore = new FlashcardStoreClass(db);
