import knex, { Knex } from 'knex';

const isProduction = process.env.NODE_ENV === 'production';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const host = isProduction ? requireEnv('DB_HOST') : (process.env.DB_HOST ?? 'localhost');

const dbConfig: Knex.Config = {
  client: 'pg',
  connection: {
    host,
    port: Number(process.env.DB_PORT ?? 5432),
    user: isProduction ? requireEnv('DB_USER') : (process.env.DB_USER ?? 'postgres'),
    password: isProduction ? requireEnv('DB_PASSWORD') : (process.env.DB_PASSWORD ?? 'postgres'),
    database: isProduction ? requireEnv('DB_NAME') : (process.env.DB_NAME ?? 'ragdb'),
    ...(isProduction || host.includes('neon.tech')
      ? { ssl: { rejectUnauthorized: true } }
      : {}),
  },
  pool: { min: 0, max: 10 },
};

export const db = knex(dbConfig);
