import mongoose from 'mongoose';
import { DateTime } from 'luxon';
import { ulid } from 'ulid';
import { AuctionModel } from '../models/auction.model.js';
import { BidModel } from '../models/bid.model.js';
import { WinnerModel } from '../models/winner.model.js';
import { UserModel } from '../models/user.model.js';
import { LedgerModel } from '../models/ledger.model.js';
import { assertIntCents } from './money.js';

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
    return WinnerModel.find({ auctionId }).sort({ giftNumber: 1 }).limit(limit).populate('userId', { username: 1 }).lean();
  }

  /**
   * Debug/contest helper: verifies key money + concurrency invariants.
   * - Sum of all active bids equals sum of all users' reservedCents for those users.
   * - No wallet goes negative.
   */
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
    let negatives: any[] = [];
    for (const u of users) {
      sumUserReserved += u.wallet.reservedCents;
      const expected = reservedByUser.get(u._id.toString()) ?? 0;
      perUser.push({ userId: u._id.toString(), username: u.username, reservedCents: u.wallet.reservedCents, expectedFromBidsCents: expected, ok: u.wallet.reservedCents === expected });
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

        await LedgerModel.create([
          {
            userId: user._id,
            type: 'RESERVE',
            amountCents: delta,
            refType: 'BID',
            refId: `${auction._id.toString()}:${user._id.toString()}:${entryId}:${ulid()}`,
            meta: { auctionId: auction._id.toString(), entryId, newBidCents: args.amountCents, prevBidCents: prev },
          },
        ], { session });

        // Anti-sniping: extend round if bid arrives near end.
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
      return result;
    } finally {
      session.endSession();
    }
  }

  /**
   * Called by the scheduler.
   * Finds due auctions and settles them one-by-one (transactions per auction).
   */
  static async settleDueAuctions() {
    const now = nowDate();
    // Clear stale locks (e.g. if a process died mid-transaction) older than 2 minutes.
    await AuctionModel.updateMany(
      { status: 'running', settling: true, settlingAt: { $lte: DateTime.fromJSDate(now).minus({ minutes: 2 }).toJSDate() } },
      { $set: { settling: false }, $unset: { settlingLockId: '', settlingAt: '' } }
    );
    const due = await AuctionModel.find({ status: 'running', currentRoundEndsAt: { $lte: now } })
      .select({ _id: 1 })
      .lean();

    for (const a of due) {
      await this.settleRound(a._id.toString(), now);
    }
  }

  static async settleRound(auctionId: string, now = nowDate()) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const lockId = ulid();
        // Acquire a settlement lock so multiple instances can't settle the same round concurrently.
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

        if (!auction) return; // nothing to do or another worker is settling
        if (!auction.currentRoundEndsAt) {
          auction.settling = false;
          auction.settlingLockId = undefined;
          auction.settlingAt = undefined;
          await auction.save({ session });
          return;
        }

        const winnersCount = Math.min(auction.itemsPerRound, auction.remainingItems);

        // Get top bids (active only). Tie-breaker: earlier lastBidAt wins.
        const topBids = await BidModel.find({ auctionId: auction._id, active: true })
          .sort({ amountCents: -1, lastBidAt: 1 })
          .limit(winnersCount)
          .session(session);

        // If there are not enough bidders, we still proceed: only existing bids can win.
        const actualWinners = topBids;

        // Charge winners and mark their entries as won.
        for (let i = 0; i < actualWinners.length; i++) {
          const b = actualWinners[i]!;
          const giftNumber = auction.nextGiftNumber + i;

          await WinnerModel.create([
            {
              auctionId: auction._id,
              round: auction.currentRound,
              userId: b.userId,
              entryId: b.entryId,
              amountCents: b.amountCents,
              giftNumber,
            },
          ], { session });

          const user = await UserModel.findById(b.userId).session(session);
          if (!user) throw new Error('USER_NOT_FOUND');
          if (user.wallet.reservedCents < b.amountCents) throw new Error('INVARIANT_RESERVED_LT_BID');

          user.wallet.reservedCents -= b.amountCents;
          await user.save({ session });

          await LedgerModel.create([
            {
              userId: user._id,
              type: 'CHARGE',
              amountCents: b.amountCents,
              refType: 'WIN',
              refId: `${auction._id.toString()}:${auction.currentRound}:${giftNumber}:${b.userId.toString()}:${b.entryId}`,
              meta: { auctionId: auction._id.toString(), round: auction.currentRound, giftNumber, bidCents: b.amountCents },
            },
          ], { session });

          b.active = false;
          await b.save({ session });
        }

        // Reduce remaining items by actual awarded count.
        auction.remainingItems -= actualWinners.length;
        auction.nextGiftNumber += actualWinners.length;

        if (auction.remainingItems <= 0) {
          // Refund everyone else and end auction.
          const losers = await BidModel.find({ auctionId: auction._id, active: true }).session(session);
          for (const b of losers) {
            const user = await UserModel.findById(b.userId).session(session);
            if (!user) throw new Error('USER_NOT_FOUND');
            if (user.wallet.reservedCents < b.amountCents) throw new Error('INVARIANT_RESERVED_LT_BID');

            user.wallet.reservedCents -= b.amountCents;
            user.wallet.availableCents += b.amountCents;
            await user.save({ session });

            await LedgerModel.create([
              {
                userId: user._id,
                type: 'REFUND',
                amountCents: b.amountCents,
                refType: 'AUCTION_END',
                refId: `${auction._id.toString()}:refund:${b.userId.toString()}:${b.entryId}:${ulid()}`,
                meta: { auctionId: auction._id.toString(), entryId: b.entryId, bidCents: b.amountCents },
              },
            ], { session });

            b.active = false;
            await b.save({ session });
          }

          auction.status = 'ended';
          auction.currentRoundEndsAt = null;
          auction.currentRoundStartedAt = null;
          auction.currentRoundExtendedBySec = 0;
          auction.settling = false;
          auction.settlingLockId = undefined;
          auction.settlingAt = undefined;
          await auction.save({ session });
          return;
        }

        // Next round
        auction.currentRound += 1;
        auction.currentRoundStartedAt = now;
        auction.currentRoundEndsAt = DateTime.fromJSDate(now).plus({ seconds: auction.roundDurationSec }).toJSDate();
        auction.currentRoundExtendedBySec = 0;
        auction.settling = false;
        auction.settlingLockId = undefined;
        auction.settlingAt = undefined;
        await auction.save({ session });
      });
    } finally {
      session.endSession();
    }
  }
}
