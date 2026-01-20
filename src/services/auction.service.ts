import mongoose from 'mongoose';
import { DateTime } from 'luxon';
import { ulid } from 'ulid';
import { AuctionModel } from '../models/auction.model.js';
import { BidModel } from '../models/bid.model.js';
import { WinnerModel } from '../models/winner.model.js';
import { UserModel } from '../models/user.model.js';
import { LedgerModel } from '../models/ledger.model.js';
import { assertIntCents } from './money.js';
import { logger } from '../config/logger.js';

export type CreateAuctionInput = {
  title: string;
  totalItems: number;
  itemsPerRound: number;
  roundDurationSec: number;
  minBidCents: number;
  antiSnipeWindowSec: number;
  antiSnipeExtensionSec: number;
  antiSnipeMaxTotalExtensionSec: number;
};

function nowDate() {
  return new Date();
}

function msSince(t0: number) {
  return Date.now() - t0;
}

export class AuctionService {
  static async createAuction(input: CreateAuctionInput) {
    assertIntCents(input.minBidCents, 'minBidCents');
    if (input.totalItems <= 0) throw new Error('TOTAL_ITEMS_MUST_BE_POSITIVE');
    if (input.itemsPerRound <= 0) throw new Error('ITEMS_PER_ROUND_MUST_BE_POSITIVE');
    if (input.itemsPerRound > input.totalItems) throw new Error('ITEMS_PER_ROUND_GT_TOTAL');
    if (input.roundDurationSec < 10) throw new Error('ROUND_DURATION_TOO_SMALL');

    const doc = await AuctionModel.create({
      title: input.title,
      minBidCents: input.minBidCents,
      totalItems: input.totalItems,
      itemsPerRound: input.itemsPerRound,
      roundDurationSec: input.roundDurationSec,
      antiSnipeWindowSec: input.antiSnipeWindowSec,
      antiSnipeExtensionSec: input.antiSnipeExtensionSec,
      antiSnipeMaxTotalExtensionSec: input.antiSnipeMaxTotalExtensionSec,
      status: 'draft',
      currentRound: 0,
      currentRoundEndsAt: null,
      currentRoundExtendedBySec: 0,
      remainingItems: input.totalItems,
      nextGiftNumber: 1,
    });

    return doc;
  }

  static async startAuction(auctionId: string) {
    const session = await mongoose.startSession();
    try {
      let updated: any;
      await session.withTransaction(async () => {
        const auction = await AuctionModel.findById(auctionId).session(session);
        if (!auction) throw new Error('AUCTION_NOT_FOUND');
        if (auction.status !== 'draft') throw new Error('AUCTION_NOT_DRAFT');

        auction.status = 'running';
        auction.currentRound = 1;
        const now = nowDate();
        auction.currentRoundStartedAt = now;
        auction.currentRoundEndsAt = DateTime.fromJSDate(now).plus({ seconds: auction.roundDurationSec }).toJSDate();
        auction.currentRoundExtendedBySec = 0;
        auction.settling = false;
        auction.settlingLockId = undefined;
        auction.settlingAt = undefined;
        await auction.save({ session });
        updated = auction.toObject();

        logger.info(
          { auctionId: auction._id.toString(), round: auction.currentRound, endsAt: auction.currentRoundEndsAt },
          'auction started'
        );
      });
      return updated;
    } finally {
      session.endSession();
    }
  }

  static async getAuction(auctionId: string) {
    const auction = await AuctionModel.findById(auctionId).lean();
    if (!auction) throw new Error('AUCTION_NOT_FOUND');
    const winners = await WinnerModel.find({ auctionId }).sort({ giftNumber: 1 }).limit(200).lean();
    return { auction, winners };
  }

  static async getLeaderboard(auctionId: string, limit = 100) {
    return BidModel.find({ auctionId, active: true })
      .sort({ amountCents: -1, lastBidAt: 1 })
      .limit(limit)
      .populate('userId', { username: 1 })
      .lean();
  }

  static async getWinners(auctionId: string, limit = 200) {
    return WinnerModel.find({ auctionId })
      .sort({ giftNumber: 1 })
      .limit(limit)
      .populate('userId', { username: 1 })
      .lean();
  }

  static async checkInvariants(auctionId: string) {
    const auction = await AuctionModel.findById(auctionId).lean();
    if (!auction) throw new Error('AUCTION_NOT_FOUND');

    const activeBids = await BidModel.find({ auctionId, active: true }).lean();
    const reservedByUser = new Map<string, number>();
    let sumActiveBids = 0;

    for (const b of activeBids) {
      sumActiveBids += b.amountCents;
      const k = b.userId.toString();
      reservedByUser.set(k, (reservedByUser.get(k) ?? 0) + b.amountCents);
    }

    const users = await UserModel.find({ _id: { $in: Array.from(reservedByUser.keys()) } }).lean();
    const perUser: any[] = [];
    let sumUserReserved = 0;
    const negatives: any[] = [];

    for (const u of users) {
      sumUserReserved += u.wallet.reservedCents;
      const expected = reservedByUser.get(u._id.toString()) ?? 0;
      perUser.push({
        userId: u._id.toString(),
        username: u.username,
        reservedCents: u.wallet.reservedCents,
        expectedFromBidsCents: expected,
        ok: u.wallet.reservedCents === expected,
      });
      if (u.wallet.availableCents < 0 || u.wallet.reservedCents < 0) {
        negatives.push({ userId: u._id.toString(), username: u.username, wallet: u.wallet });
      }
    }

    const mismatch = perUser.filter((x) => !x.ok);
    return {
      auctionId,
      status: auction.status,
      sumActiveBidsCents: sumActiveBids,
      usersChecked: users.length,
      sumUserReservedCents: sumUserReserved,
      ok: mismatch.length === 0 && negatives.length === 0,
      mismatch,
      negatives,
    };
  }

  static async placeBid(args: { auctionId: string; userId: string; amountCents: number; entryId?: string }) {
    const entryId = args.entryId ?? 'default';
    assertIntCents(args.amountCents, 'amountCents');
    if (args.amountCents <= 0) throw new Error('AMOUNT_MUST_BE_POSITIVE');

    const session = await mongoose.startSession();
    const t0 = Date.now();

    try {
      let result: any;

      await session.withTransaction(async () => {
        const [auction, user] = await Promise.all([
          AuctionModel.findById(args.auctionId).session(session),
          UserModel.findById(args.userId).session(session),
        ]);

        if (!auction) throw new Error('AUCTION_NOT_FOUND');
        if (!user) throw new Error('USER_NOT_FOUND');
        if (auction.status !== 'running') throw new Error('AUCTION_NOT_RUNNING');
        if (!auction.currentRoundEndsAt) throw new Error('AUCTION_ROUND_NOT_SET');

        const now = nowDate();
        if (auction.currentRoundEndsAt <= now) throw new Error('AUCTION_ROUND_ENDED');
        if (auction.settling) throw new Error('AUCTION_IS_SETTLING');
        if (auction.remainingItems <= 0) throw new Error('AUCTION_ENDED');
        if (args.amountCents < auction.minBidCents) throw new Error('BID_BELOW_MIN');

        const existing = await BidModel.findOne({ auctionId: auction._id, userId: user._id, entryId }).session(session);
        const prev = existing?.amountCents ?? 0;
        if (args.amountCents <= prev) throw new Error('BID_MUST_INCREASE');

        const delta = args.amountCents - prev;
        if (user.wallet.availableCents < delta) throw new Error('INSUFFICIENT_AVAILABLE_BALANCE');

        // Reserve delta
        user.wallet.availableCents -= delta;
        user.wallet.reservedCents += delta;
        await user.save({ session });

        await BidModel.updateOne(
          { auctionId: auction._id, userId: user._id, entryId },
          {
            $set: {
              amountCents: args.amountCents,
              active: true,
              lastBidAt: now,
            },
            $setOnInsert: {
              auctionId: auction._id,
              userId: user._id,
              entryId,
            },
          },
          { upsert: true, session }
        );

        await LedgerModel.create(
          [
            {
              userId: user._id,
              type: 'RESERVE',
              amountCents: delta,
              refType: 'BID',
              refId: `${auction._id.toString()}:${user._id.toString()}:${entryId}:${ulid()}`,
              meta: { auctionId: auction._id.toString(), entryId, newBidCents: args.amountCents, prevBidCents: prev },
            },
          ],
          { session }
        );

        // Anti-sniping
        const endsAt = DateTime.fromJSDate(auction.currentRoundEndsAt);
        const nowDt = DateTime.fromJSDate(now);
        const windowSec = auction.antiSnipeWindowSec;
        const extensionSec = auction.antiSnipeExtensionSec;
        const maxTotalExt = auction.antiSnipeMaxTotalExtensionSec;

        if (windowSec > 0 && extensionSec > 0) {
          const threshold = endsAt.minus({ seconds: windowSec });
          if (nowDt >= threshold) {
            const remainingExt = Math.max(0, maxTotalExt - auction.currentRoundExtendedBySec);
            const add = maxTotalExt === 0 ? extensionSec : Math.min(extensionSec, remainingExt);
            if (add > 0) {
              auction.currentRoundEndsAt = endsAt.plus({ seconds: add }).toJSDate();
              auction.currentRoundExtendedBySec += add;
              await auction.save({ session });

              logger.debug(
                {
                  auctionId: auction._id.toString(),
                  round: auction.currentRound,
                  addSec: add,
                  totalExt: auction.currentRoundExtendedBySec,
                },
                'anti-snipe extended round'
              );
            }
          }
        }

        result = {
          ok: true,
          auctionId: auction._id.toString(),
          userId: user._id.toString(),
          entryId,
          bidCents: args.amountCents,
        };
      });

      logger.debug(
        { auctionId: args.auctionId, userId: args.userId, entryId, bid: args.amountCents, ms: msSince(t0) },
        'bid placed'
      );

      return result;
    } finally {
      session.endSession();
    }
  }

  /**
   * Scheduler entrypoint.
   * 1) clears stale locks
   * 2) finds due auctions
   * 3) settles each (best-effort, isolated)
   */
  static async settleDueAuctions() {
    const t0 = Date.now();
    const now = nowDate();

    const staleCutoff = DateTime.fromJSDate(now).minus({ minutes: 2 }).toJSDate();
    const staleRes = await AuctionModel.updateMany(
      { status: 'running', settling: true, settlingAt: { $lte: staleCutoff } },
      { $set: { settling: false }, $unset: { settlingLockId: '', settlingAt: '' } }
    );

    const due = await AuctionModel.find({ status: 'running', currentRoundEndsAt: { $lte: now } })
      .select({ _id: 1, currentRound: 1 })
      .lean();

    if (staleRes.modifiedCount || due.length) {
      logger.info(
        { staleLocksCleared: staleRes.modifiedCount, dueCount: due.length, ms: msSince(t0) },
        'settleDueAuctions summary'
      );
    } else {
      logger.debug({ ms: msSince(t0) }, 'settleDueAuctions: nothing due');
    }

    for (const a of due) {
      try {
        await this.settleRound(a._id.toString(), now);
      } catch (err) {
        // IMPORTANT: never let one auction break the whole scheduler tick
        logger.error({ err, auctionId: a._id.toString() }, 'settleRound failed (outer)');
      }
    }
  }

  static async settleRound(auctionId: string, now = nowDate()) {
    const t0 = Date.now();
    const lockId = ulid();

    const session = await mongoose.startSession();

    logger.info({ auctionId, lockId }, 'SETTLE start');

    try {
      await session.withTransaction(async () => {
        // 1) Acquire settlement lock (atomic)
        const auction = await AuctionModel.findOneAndUpdate(
          {
            _id: auctionId,
            status: 'running',
            currentRoundEndsAt: { $lte: now },
            settling: { $ne: true },
          },
          { $set: { settling: true, settlingLockId: lockId, settlingAt: now } },
          { new: true, session }
        );

        if (!auction) {
          logger.debug({ auctionId, ms: msSince(t0) }, 'SETTLE skip (no lock / not due / already settling)');
          return;
        }

        if (!auction.currentRoundEndsAt) {
          logger.warn({ auctionId }, 'SETTLE: currentRoundEndsAt is null, unlocking');
          auction.settling = false;
          auction.settlingLockId = undefined;
          auction.settlingAt = undefined;
          await auction.save({ session });
          return;
        }

        const round = auction.currentRound;
        const winnersCount = Math.min(auction.itemsPerRound, auction.remainingItems);

        logger.info(
          {
            auctionId,
            round,
            winnersCount,
            remainingItems: auction.remainingItems,
            endsAt: auction.currentRoundEndsAt,
          },
          'SETTLE locked'
        );

        // 2) Select winners (top active bids)
        const tWinners = Date.now();
        const topBids = await BidModel.find({ auctionId: auction._id, active: true })
          .sort({ amountCents: -1, lastBidAt: 1 })
          .limit(winnersCount)
          .maxTimeMS(8000)
          .session(session);

        const actualWinners = topBids;

        logger.info(
          { auctionId, round, winners: actualWinners.length, ms: msSince(tWinners) },
          'SETTLE winners selected'
        );

        // 3) Charge winners (bulk)
        const tCharge = Date.now();

        const winnersDocs = actualWinners.map((b, i) => ({
          auctionId: auction._id,
          round,
          userId: b.userId,
          entryId: b.entryId,
          amountCents: b.amountCents,
          giftNumber: auction.nextGiftNumber + i,
        }));

        if (winnersDocs.length > 0) {
          await WinnerModel.insertMany(winnersDocs, { session });

          // Update users reservedCents -= bid (guard invariant)
          for (const w of winnersDocs) {
            const r = await UserModel.updateOne(
              { _id: w.userId, 'wallet.reservedCents': { $gte: w.amountCents } },
              { $inc: { 'wallet.reservedCents': -w.amountCents } },
              { session }
            );
            if (r.matchedCount !== 1) throw new Error('INVARIANT_RESERVED_LT_BID');
          }

          // Ledger for charges
          const chargeLedgers = winnersDocs.map((w) => ({
            userId: w.userId,
            type: 'CHARGE' as const,
            amountCents: w.amountCents,
            refType: 'WIN' as const,
            refId: `${auction._id.toString()}:${round}:${w.giftNumber}:${w.userId.toString()}:${w.entryId}`,
            meta: { auctionId: auction._id.toString(), round, giftNumber: w.giftNumber, bidCents: w.amountCents },
          }));
          await LedgerModel.insertMany(chargeLedgers, { session });

          // Mark winner bids inactive
          const winnerBidOps = actualWinners.map((b) => ({
            updateOne: {
              filter: { _id: b._id },
              update: { $set: { active: false } },
            },
          }));
          await BidModel.bulkWrite(winnerBidOps, { session });
        }

        logger.info({ auctionId, round, ms: msSince(tCharge) }, 'SETTLE winners charged');

        // 4) Update auction counters
        auction.remainingItems -= winnersDocs.length;
        auction.nextGiftNumber += winnersDocs.length;

        // 5) End auction if no items left: refund losers
        if (auction.remainingItems <= 0) {
          const tRefund = Date.now();

          const losers = await BidModel.find({ auctionId: auction._id, active: true }).session(session);
          if (losers.length > 0) {
            // Refund each active bid
            for (const b of losers) {
              const r = await UserModel.updateOne(
                { _id: b.userId, 'wallet.reservedCents': { $gte: b.amountCents } },
                { $inc: { 'wallet.reservedCents': -b.amountCents, 'wallet.availableCents': b.amountCents } },
                { session }
              );
              if (r.matchedCount !== 1) throw new Error('INVARIANT_RESERVED_LT_BID');
            }

            const refundLedgers = losers.map((b) => ({
              userId: b.userId,
              type: 'REFUND' as const,
              amountCents: b.amountCents,
              refType: 'AUCTION_END' as const,
              refId: `${auction._id.toString()}:refund:${b.userId.toString()}:${b.entryId}:${ulid()}`,
              meta: { auctionId: auction._id.toString(), entryId: b.entryId, bidCents: b.amountCents },
            }));
            await LedgerModel.insertMany(refundLedgers, { session });

            const loserOps = losers.map((b) => ({
              updateOne: {
                filter: { _id: b._id },
                update: { $set: { active: false } },
              },
            }));
            await BidModel.bulkWrite(loserOps, { session });
          }

          auction.status = 'ended';
          auction.currentRoundEndsAt = null;
          auction.currentRoundStartedAt = null;
          auction.currentRoundExtendedBySec = 0;

          auction.settling = false;
          auction.settlingLockId = undefined;
          auction.settlingAt = undefined;

          await auction.save({ session });

          logger.info(
            { auctionId, round, refundedLosers: losers.length, ms: msSince(tRefund) },
            'SETTLE auction ended + losers refunded'
          );

          return;
        }

        const nextRound = auction.currentRound + 1;
        auction.currentRound = nextRound;
        auction.currentRoundStartedAt = now;
        auction.currentRoundEndsAt = DateTime.fromJSDate(now).plus({ seconds: auction.roundDurationSec }).toJSDate();
        auction.currentRoundExtendedBySec = 0;

        auction.settling = false;
        auction.settlingLockId = undefined;
        auction.settlingAt = undefined;

        await auction.save({ session });

        logger.info(
          { auctionId, fromRound: round, toRound: nextRound, remainingItems: auction.remainingItems },
          'SETTLE next round started'
        );
      });

      logger.info({ auctionId, lockId, ms: msSince(t0) }, 'SETTLE done');
    } catch (err) {
      logger.error({ err, auctionId, lockId, ms: msSince(t0) }, 'SETTLE failed');

      try {
        const r = await AuctionModel.updateOne(
          { _id: auctionId, settling: true, settlingLockId: lockId },
          { $set: { settling: false }, $unset: { settlingLockId: '', settlingAt: '' } }
        );
        if (r.modifiedCount) {
          logger.warn({ auctionId, lockId }, 'SETTLE recovered by best-effort unlock');
        }
      } catch (unlockErr) {
        logger.error({ err: unlockErr, auctionId, lockId }, 'SETTLE unlock failed');
      }

      throw err;
    } finally {
      session.endSession();
    }
  }
}
