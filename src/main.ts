import { startBot } from './bot.ts';
import { startServer } from './server.ts';

for (const name of ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'PORT']) {
  if (!process.env[name]) throw new Error(`Missing ${name} in the environment (see .env.example)`);
}

startServer(Number(process.env.PORT));
await startBot(process.env.DISCORD_TOKEN!);
