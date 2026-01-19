import mongoose from 'mongoose';
import { ulid } from 'ulid';
import { UserModel } from '../models/user.model.js';
import { LedgerModel } from '../models/ledger.model.js';
import { assertIntCents } from './money.js';

export class UserService {
  static async createUser(username: string) {
    const doc = await UserModel.create({ username, wallet: { availableCents: 0, reservedCents: 0 } });
    return doc;
  }

  static async getUser(userId: string) {
    const doc = await UserModel.findById(userId).lean();
    if (!doc) throw new Error('USER_NOT_FOUND');
    return doc;
  }

  static async topup(userId: string, amountCents: number) {
    assertIntCents(amountCents, 'amountCents');
    if (amountCents <= 0) throw new Error('AMOUNT_MUST_BE_POSITIVE');

    const session = await mongoose.startSession();
    try {
      let updated: any;
      await session.withTransaction(async () => {
        const user = await UserModel.findById(userId).session(session);
        if (!user) throw new Error('USER_NOT_FOUND');

        user.wallet.availableCents += amountCents;
        await user.save({ session });

        await LedgerModel.create([
          {
            userId: user._id,
            type: 'TOPUP',
            amountCents,
            refType: 'TOPUP',
            refId: ulid(),
            meta: { method: 'demo' },
          },
        ], { session });

        updated = user.toObject();
      });
      return updated;
    } finally {
      session.endSession();
    }
  }

  static async getLedger(userId: string, limit = 100) {
    return LedgerModel.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean();
  }
}
