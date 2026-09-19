import { buildGatewayServer } from './server.js';
import { config } from './config.js';
import { Database } from './db.js';
import { AIOrchestrator } from '../../orchestrator/src/pipeline/orchestrator.js';
import { KnowledgeBaseRetriever } from '../../orchestrator/src/kb/retriever.js';
import { ToolRegistry } from '../../orchestrator/src/tools/registry.js';
import { createLlmClient } from '../../orchestrator/src/llm/factory.js';
import { GuardrailEngine } from '../../orchestrator/src/pipeline/guardrails.js';
import { IntentClassifier } from '../../orchestrator/src/pipeline/intent-classifier.js';
import { WaitingCompanion } from '../../orchestrator/src/pipeline/waiting-companion.js';

async function main() {
  const db = new Database(config.databaseUrl);

  // Inisialisasi AI Orchestrator untuk mode bayangan (TASK-08)
  const kbRetriever = new KnowledgeBaseRetriever(db.pool);
  const toolRegistry = new ToolRegistry();
  // LLM_PROVIDER=mock (default) atau anthropic — lihat orchestrator/src/llm/factory.ts
  const llmClient = createLlmClient();
  const guardrails = new GuardrailEngine(db.pool);
  try {
    await guardrails.loadAllFromDatabase();
    await guardrails.validateBotActivationGuardrails();
  } catch (err: any) {
    console.warn('[Orchestrator] Guardrail check warning:', err.message);
  }
  const intentClassifier = new IntentClassifier();
  const orchestrator = new AIOrchestrator({
    kbRetriever,
    toolRegistry,
    llmClient,
    guardrails,
    intentClassifier,
  });

  const waitingCompanion = new WaitingCompanion({
    guardrails,
    kbRetriever,
    intentClassifier,
  });

  const { app } = await buildGatewayServer({
    db,
    orchestrator,
    waitingCompanion,
    enforceAuth: true,
  });
  try {
    await db.seedInitialAgents();
    await db.ensureAutoReplyTable();
    await db.seedDefaultAutoReplyRules();
    const address = await app.listen({ port: config.port, host: config.host });
    console.log(`Chat Gateway berjalan di ${address}`);
    console.log(`Mode Bayangan (Shadow Mode TASK-08) aktif.`);
  } catch (err) {
    console.error('Gagal menjalankan Gateway:', err);
    process.exit(1);
  }
}

main();
