import mongoose, { type InferSchemaType } from 'mongoose';

const BidSchema = new mongoose.Schema(
  {
    auctionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Auction', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    entryId: { type: String, required: true },
    amountCents: { type: Number, required: true, min: 0 },
    active: { type: Boolean, required: true, index: true },
    lastBidAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: 'v' }
);

BidSchema.index({ auctionId: 1, userId: 1, entryId: 1 }, { unique: true });
BidSchema.index({ auctionId: 1, active: 1, amountCents: -1, lastBidAt: 1 });

export type BidDoc = InferSchemaType<typeof BidSchema> & mongoose.Document;
export const BidModel = mongoose.model('Bid', BidSchema);
