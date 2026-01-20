import * as http from 'http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectMongo, disconnectMongo } from './db/mongoose.js';
import { createApp } from './api/http.js';
import { Scheduler } from './services/scheduler.js';

async function bootstrap() {
  await connectMongo();

  const app = createApp();
  const server = http.createServer(app);

  const scheduler = new Scheduler();
  scheduler.start(1000);

  server.listen(env.port, () => {
    logger.info({ port: env.port }, 'server started');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    scheduler.stop();
    server.close(async () => {
      await disconnectMongo();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'fatal bootstrap error');
  process.exit(1);
});
