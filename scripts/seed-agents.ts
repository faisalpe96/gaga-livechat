import { Database } from '../services/gateway/src/db.js';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const db = new Database();
  try {
    console.log('Menyemai data agen awal...');
    await db.seedInitialAgents();
    const agents = await db.listAgents();
    console.log(`Berhasil menyemai ${agents.length} agen:`);
    for (const a of agents) {
      console.log(`- [${a.id}] ${a.name} (${a.locales.join(', ')}) - Status: ${a.status}`);
    }
  } catch (err) {
    console.error('Gagal menyemai data agen:', err);
    process.exit(1);
  } finally {
    await db.close();
  }
}

main();
