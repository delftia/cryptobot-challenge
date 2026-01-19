import mongoose, { type InferSchemaType } from 'mongoose';

const WinnerSchema = new mongoose.Schema(
  {
    auctionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Auction', required: true, index: true },
    round: { type: Number, required: true, min: 1, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    entryId: { type: String, required: true },
    amountCents: { type: Number, required: true, min: 0 },
    giftNumber: { type: Number, required: true, min: 1, index: true }
  },
  { timestamps: true }
);

WinnerSchema.index({ auctionId: 1, round: 1, giftNumber: 1 }, { unique: true });
WinnerSchema.index({ auctionId: 1, giftNumber: 1 }, { unique: true });

export type WinnerDoc = InferSchemaType<typeof WinnerSchema> & mongoose.Document;
export const WinnerModel = mongoose.model('Winner', WinnerSchema);
