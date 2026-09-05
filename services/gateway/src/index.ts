import { buildGatewayServer } from './server.js';
import { config } from './config.js';

async function main() {
  const { app } = await buildGatewayServer();
  try {
    const address = await app.listen({ port: config.port, host: config.host });
    console.log(`Chat Gateway berjalan di ${address}`);
  } catch (err) {
    console.error('Gagal menjalankan Gateway:', err);
    process.exit(1);
  }
}

main();
