import mongoose, { type InferSchemaType } from 'mongoose';

export type LedgerType = 'TOPUP' | 'RESERVE' | 'RELEASE' | 'CHARGE' | 'REFUND';

const LedgerSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, required: true, enum: ['TOPUP','RESERVE','RELEASE','CHARGE','REFUND'], index: true },
    amountCents: { type: Number, required: true },
    refType: { type: String, required: true },
    refId: { type: String, required: true },
    meta: { type: mongoose.Schema.Types.Mixed, required: false }
  },
  { timestamps: true }
);

LedgerSchema.index({ userId: 1, createdAt: -1 });

export type LedgerDoc = InferSchemaType<typeof LedgerSchema> & mongoose.Document;
export const LedgerModel = mongoose.model('Ledger', LedgerSchema);
