import type { Knex } from 'knex';
import { db } from '../db/knex';

export interface QuizRecord {
  id: string;
  user_id: string;
  title: string;
  quiz_data: unknown;
  input_data: unknown;
  created_at: string;
}

export interface QuizListItem {
  id: string;
  title: string;
  question_count: number;
  created_at: string;
}

class QuizStoreClass {
  private knex: Knex;

  constructor(knex: Knex) {
    this.knex = knex;
  }

  async save(
    userId: string,
    title: string,
    quizData: unknown,
    inputData: unknown
  ): Promise<string> {
    const [row] = await this.knex('quizzes')
      .insert({
        user_id: userId,
        title,
        quiz_data: JSON.stringify(quizData),
        input_data: JSON.stringify(inputData),
      })
      .returning('id');
    return row.id;
  }

  async list(userId: string): Promise<QuizListItem[]> {
    const rows = await this.knex('quizzes')
      .select('id', 'title', 'quiz_data', 'created_at')
      .where('user_id', userId)
      .orderBy('created_at', 'desc');

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      question_count: (r.quiz_data as any)?.questions?.length ?? 0,
      created_at: r.created_at,
    }));
  }

  async get(quizId: string, userId: string): Promise<QuizRecord | null> {
    const row = await this.knex('quizzes')
      .where({ id: quizId, user_id: userId })
      .first();
    return row ?? null;
  }

  async delete(quizId: string, userId: string): Promise<boolean> {
    const deleted = await this.knex('quizzes')
      .where({ id: quizId, user_id: userId })
      .del();
    return deleted > 0;
  }
}

export const QuizStore = new QuizStoreClass(db);
