import type { Knex } from 'knex';

const host = process.env.DB_HOST ?? 'localhost';

const config: { [key: string]: Knex.Config } = {
  development: {
    client: 'pg',
    connection: {
      host,
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      database: process.env.DB_NAME ?? 'ragdb',
      ...(host.includes('neon.tech') ? { ssl: { rejectUnauthorized: true } } : {}),
    },
    migrations: {
      directory: './migrations',
      extension: 'ts',
    },
  },
};

export default config;
