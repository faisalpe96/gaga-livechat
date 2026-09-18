import { buildOrchestratorServer } from './server.js';
import { config } from './config.js';

async function main() {
  const { app } = await buildOrchestratorServer();
  try {
    const address = await app.listen({ port: config.port, host: config.host });
    console.log(`AI Orchestrator berjalan di ${address}`);
  } catch (err) {
    console.error('Gagal menjalankan Orchestrator:', err);
    process.exit(1);
  }
}

main();
