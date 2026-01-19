import { ulid } from 'ulid';
import { UserModel } from '../models/user.model.js';
import { AuctionService } from './auction.service.js';

type BotConfig = {
  count: number;
  maxBidCents: number;
  intervalMs: number;
  usernamePrefix: string;
};

type BotRunner = {
  stop: () => void;
  id: string;
  startedAt: Date;
  config: BotConfig;
};

const runners = new Map<string, BotRunner>();

export class BotService {
  static list(auctionId: string) {
    const r = runners.get(auctionId);
    return r ? { running: true, ...r } : { running: false };
  }

  static async start(auctionId: string, cfg: BotConfig) {
    if (runners.has(auctionId)) throw new Error('BOTS_ALREADY_RUNNING');

    // Ensure bot users exist and have balance.
    const bots: { userId: string; entryId: string }[] = [];
    for (let i = 0; i < cfg.count; i++) {
      const username = `${cfg.usernamePrefix}_${i}`;
      let user = await UserModel.findOne({ username });
      if (!user) {
        user = await UserModel.create({ username, wallet: { availableCents: cfg.maxBidCents * 10, reservedCents: 0 } });
      } else {
        // Top-up if needed.
        const need = Math.max(0, cfg.maxBidCents * 10 - user.wallet.availableCents);
        user.wallet.availableCents += need;
        await user.save();
      }
      bots.push({ userId: user._id.toString(), entryId: `bot-${ulid()}` });
    }

    let stopped = false;
    const timer = setInterval(async () => {
      if (stopped) return;
      // Random bot places / increases bid
      const pick = bots[Math.floor(Math.random() * bots.length)]!;
      const bid = 1 + Math.floor(Math.random() * cfg.maxBidCents);
      try {
        await AuctionService.placeBid({ auctionId, userId: pick.userId, entryId: pick.entryId, amountCents: bid });
      } catch {
        // ignore (insufficient funds, ended, etc.)
      }
    }, cfg.intervalMs);

    const runner: BotRunner = {
      id: ulid(),
      startedAt: new Date(),
      config: cfg,
      stop: () => {
        stopped = true;
        clearInterval(timer);
        runners.delete(auctionId);
      },
    };

    runners.set(auctionId, runner);
    return runner;
  }

  static stop(auctionId: string) {
    const r = runners.get(auctionId);
    if (!r) return { stopped: false };
    r.stop();
    return { stopped: true };
  }
}
