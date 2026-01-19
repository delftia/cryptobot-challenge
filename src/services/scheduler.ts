import { AuctionService } from './auction.service.js';
import { logger } from '../config/logger.js';

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private running = false;

  start(intervalMs = 1000) {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      if (this.running) return;
      this.running = true;
      try {
        await AuctionService.settleDueAuctions();
      } catch (err) {
        logger.error({ err }, 'scheduler tick failed');
      } finally {
        this.running = false;
      }
    }, intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
