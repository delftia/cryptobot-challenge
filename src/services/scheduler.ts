import { AuctionService } from './auction.service.js';
import { logger } from '../config/logger.js';

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label}_TIMEOUT_${ms}ms`)), ms);
    t.unref?.();
  });
  return Promise.race([p.finally(() => t && clearTimeout(t)), timeout]);
}

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private running = false;

  start(intervalMs = 1000) {
    if (this.timer) return;

    logger.info({ intervalMs }, 'scheduler started');

    this.timer = setInterval(async () => {
      if (this.running) return;
      this.running = true;

      const startedAt = Date.now();
      try {
        logger.debug('scheduler tick start');

        await withTimeout(AuctionService.settleDueAuctions(), 20_000, 'SCHEDULER_TICK');

        logger.debug({ ms: Date.now() - startedAt }, 'scheduler tick done');
      } catch (err) {
        logger.error({ err, ms: Date.now() - startedAt }, 'scheduler tick failed');
      } finally {
        this.running = false;
      }
    }, intervalMs);

    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    logger.info('scheduler stopped');
  }
}
