import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('quizzes', (t) => {
    t.text('run_id').nullable().unique();
  });
  await knex.schema.alterTable('flashcards', (t) => {
    t.text('run_id').nullable().unique();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('quizzes', (t) => {
    t.dropColumn('run_id');
  });
  await knex.schema.alterTable('flashcards', (t) => {
    t.dropColumn('run_id');
  });
}
