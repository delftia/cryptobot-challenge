import mongoose, { type InferSchemaType } from 'mongoose';

export type AuctionStatus = 'draft' | 'running' | 'ended';

const AuctionSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    minBidCents: { type: Number, required: true, min: 0 },
    totalItems: { type: Number, required: true, min: 1 },
    itemsPerRound: { type: Number, required: true, min: 1 },
    roundDurationSec: { type: Number, required: true, min: 10 },
    antiSnipeWindowSec: { type: Number, required: true, min: 0 },
    antiSnipeExtensionSec: { type: Number, required: true, min: 0 },
    antiSnipeMaxTotalExtensionSec: { type: Number, required: true, min: 0 },

    status: { type: String, required: true, enum: ['draft', 'running', 'ended'], index: true },

    currentRound: { type: Number, required: true, min: 0 },
    currentRoundStartedAt: { type: Date, required: false },
    currentRoundEndsAt: { type: Date, required: false },
    currentRoundExtendedBySec: { type: Number, required: true, min: 0 },

    // Lightweight distributed lock to make round settlement safe under multiple instances.
    settling: { type: Boolean, required: true, default: false, index: true },
    settlingLockId: { type: String, required: false },
    settlingAt: { type: Date, required: false },

    remainingItems: { type: Number, required: true, min: 0 },
    nextGiftNumber: { type: Number, required: true, min: 1 },
  },
  { timestamps: true, versionKey: 'v' }
);

AuctionSchema.index({ status: 1, currentRoundEndsAt: 1 });
AuctionSchema.index({ status: 1, settling: 1, currentRoundEndsAt: 1 });

export type AuctionDoc = InferSchemaType<typeof AuctionSchema> & mongoose.Document;
export const AuctionModel = mongoose.model('Auction', AuctionSchema);
