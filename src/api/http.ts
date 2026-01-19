import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { logger } from '../config/logger.js';
import { UserService } from '../services/user.service.js';
import { AuctionService } from '../services/auction.service.js';
import { BotService } from '../services/bot.service.js';
import { z } from 'zod';

export function createApp() {
  const app = express();
  app.use(helmet({
    crossOriginResourcePolicy: false,
  }));
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger }));
  app.use(rateLimit({ windowMs: 1000, limit: 500 }));

  // Static minimal UI
  app.use('/', express.static('public'));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // USERS
  app.post('/api/users', async (req, res, next) => {
    try {
      const body = z.object({ username: z.string().min(1).max(32) }).parse(req.body);
      const user = await UserService.createUser(body.username);
      res.status(201).json(user);
    } catch (e) { next(e); }
  });

  app.get('/api/users/:id', async (req, res, next) => {
    try {
      const user = await UserService.getUser(req.params.id);
      res.json(user);
    } catch (e) { next(e); }
  });

  app.post('/api/users/:id/topup', async (req, res, next) => {
    try {
      const body = z.object({ amountCents: z.number().int().positive() }).parse(req.body);
      const user = await UserService.topup(req.params.id, body.amountCents);
      res.json(user);
    } catch (e) { next(e); }
  });

  app.get('/api/users/:id/ledger', async (req, res, next) => {
    try {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 100)));
      const entries = await UserService.getLedger(req.params.id, limit);
      res.json(entries);
    } catch (e) { next(e); }
  });

  // AUCTIONS
  app.post('/api/auctions', async (req, res, next) => {
    try {
      const body = z.object({
        title: z.string().min(1).max(100),
        totalItems: z.number().int().positive().max(1_000_000),
        itemsPerRound: z.number().int().positive().max(100_000),
        roundDurationSec: z.number().int().positive().max(3600),
        minBidCents: z.number().int().nonnegative(),
        antiSnipeWindowSec: z.number().int().nonnegative().max(3600),
        antiSnipeExtensionSec: z.number().int().nonnegative().max(600),
        antiSnipeMaxTotalExtensionSec: z.number().int().nonnegative().max(3600)
      }).parse(req.body);

      const auction = await AuctionService.createAuction(body);
      res.status(201).json(auction);
    } catch (e) { next(e); }
  });

  app.post('/api/auctions/:id/start', async (req, res, next) => {
    try {
      const auction = await AuctionService.startAuction(req.params.id);
      res.json(auction);
    } catch (e) { next(e); }
  });

  app.get('/api/auctions/:id', async (req, res, next) => {
    try {
      const data = await AuctionService.getAuction(req.params.id);
      res.json(data);
    } catch (e) { next(e); }
  });

  app.get('/api/auctions/:id/leaderboard', async (req, res, next) => {
    try {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));
      const lb = await AuctionService.getLeaderboard(req.params.id, limit);
      res.json(lb);
    } catch (e) { next(e); }
  });

  app.get('/api/auctions/:id/winners', async (req, res, next) => {
    try {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 200)));
      const w = await AuctionService.getWinners(req.params.id, limit);
      res.json(w);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/auctions/:id/invariants', async (req, res, next) => {
    try {
      const out = await AuctionService.checkInvariants(req.params.id);
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/auctions/:id/bids', async (req, res, next) => {
    try {
      const body = z.object({
        userId: z.string().min(1),
        amountCents: z.number().int().positive(),
        entryId: z.string().min(1).max(64).optional(),
      }).parse(req.body);
      const out = await AuctionService.placeBid({ auctionId: req.params.id, ...body });
      res.status(201).json(out);
    } catch (e) { next(e); }
  });

  // Demo bots
  app.get('/api/auctions/:id/bots', async (req, res, next) => {
    try {
      res.json(BotService.list(req.params.id));
    } catch (e) { next(e); }
  });

  app.post('/api/auctions/:id/bots/start', async (req, res, next) => {
    try {
      const body = z.object({
        count: z.number().int().positive().max(500),
        maxBidCents: z.number().int().positive(),
        intervalMs: z.number().int().positive().min(20),
        usernamePrefix: z.string().min(1).max(32).default('bot')
      }).parse(req.body);

      const runner = await BotService.start(req.params.id, body);
      res.status(201).json(runner);
    } catch (e) { next(e); }
  });

  app.post('/api/auctions/:id/bots/stop', async (req, res, next) => {
    try {
      res.json(BotService.stop(req.params.id));
    } catch (e) { next(e); }
  });

  // Error handler
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err?.message ?? 'UNKNOWN_ERROR';
    const status = mapErrorToStatus(message);
    logger.warn({ err, status }, 'request failed');
    res.status(status).json({
      error: message,
      details: err?.issues ?? err?.errors ?? undefined,
    });
  });

  return app;
}

function mapErrorToStatus(code: string): number {
  if (code === 'USER_NOT_FOUND' || code === 'AUCTION_NOT_FOUND') return 404;
  if (code === 'INSUFFICIENT_AVAILABLE_BALANCE') return 409;
  if (code.startsWith('BID_') || code.startsWith('AUCTION_') || code.includes('MUST')) return 400;
  if (code === 'BOTS_ALREADY_RUNNING') return 409;
  return 400;
}
