import Fastify, { FastifyInstance } from 'fastify';
import pg from 'pg';
import { AIOrchestrator, OrchestrateRequest } from './pipeline/orchestrator.js';
import { KnowledgeBaseRetriever } from './kb/retriever.js';
import { ToolRegistry } from './tools/registry.js';
import { LlmClient, MockLlmClient } from './llm/client.js';
import { GuardrailEngine } from './pipeline/guardrails.js';
import { IntentClassifier } from './pipeline/intent-classifier.js';
import { config } from './config.js';

export interface OrchestratorServerOptions {
  pool?: pg.Pool;
  orchestrator?: AIOrchestrator;
  llmClient?: LlmClient;
}

export async function buildOrchestratorServer(
  opts: OrchestratorServerOptions = {}
): Promise<{
  app: FastifyInstance;
  orchestrator: AIOrchestrator;
  pool: pg.Pool;
}> {
  const app = Fastify({ logger: false });
  const pool = opts.pool || new pg.Pool({ connectionString: config.databaseUrl });

  const kbRetriever = new KnowledgeBaseRetriever(pool);
  const toolRegistry = new ToolRegistry();
  const llmClient = opts.llmClient || new MockLlmClient();
  const guardrails = new GuardrailEngine(pool);
  await guardrails.loadAllFromDatabase();
  await guardrails.validateBotActivationGuardrails();

  const intentClassifier = new IntentClassifier();

  const orchestrator =
    opts.orchestrator ||
    new AIOrchestrator({
      kbRetriever,
      toolRegistry,
      llmClient,
      guardrails,
      intentClassifier,
    });

  // Health check endpoints (spec/09-produksi.md Bagian 3 & 4)
  // Liveness probe
  app.get('/health/live', async () => {
    return { status: 'ok', service: 'ai-orchestrator', uptime: process.uptime() };
  });

  // Comprehensive health & readiness probe (PostgreSQL & Guardrails)
  const healthCheckHandler = async (_req: any, reply: any) => {
    let dbStatus = 'unknown';
    let isHealthy = true;

    try {
      await pool.query('SELECT 1');
      dbStatus = 'connected';
    } catch (err: any) {
      dbStatus = `error: ${err.message}`;
      isHealthy = false;
    }

    const payload = {
      status: isHealthy ? 'ok' : 'unhealthy',
      service: 'ai-orchestrator',
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      checks: {
        database: dbStatus,
        guardrails_ready: true,
      },
    };

    if (!isHealthy) {
      return reply.code(503).send(payload);
    }
    return reply.send(payload);
  };

  app.get('/health', healthCheckHandler);
  app.get('/health/ready', healthCheckHandler);

  // REST: POST /v1/orchestrate
  app.post<{ Body: OrchestrateRequest }>('/v1/orchestrate', async (req, reply) => {
    const body = req.body;

    if (!body || !body.conversation_id || !body.player || !body.player.uid) {
      return reply.code(400).send({
        error: 'Format request tidak valid: conversation_id dan player.uid wajib disertakan.',
        code: 'INVALID_REQUEST',
      });
    }

    try {
      const result = await orchestrator.process(body);
      return reply.send(result);
    } catch (err: any) {
      return reply.code(500).send({
        error: err?.message || 'Terjadi kesalahan internal pada pipeline orchestrator',
        code: 'ORCHESTRATOR_INTERNAL_ERROR',
      });
    }
  });

  return { app, orchestrator, pool };
}
