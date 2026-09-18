import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.ORCHESTRATOR_PORT || '3003', 10),
  host: process.env.ORCHESTRATOR_HOST || '127.0.0.1',
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://postgres:postgrespassword@localhost:5432/livechat',
  confidenceThreshold: 0.75,
  similarityThreshold: 0.035,
  llmProvider: process.env.LLM_PROVIDER || 'mock',
};


