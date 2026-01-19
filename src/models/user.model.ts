import mongoose, { type InferSchemaType } from 'mongoose';

const WalletSchema = new mongoose.Schema(
  {
    availableCents: { type: Number, required: true, min: 0 },
    reservedCents: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const UserSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, trim: true, unique: true, index: true },
    wallet: { type: WalletSchema, required: true },
  },
  { timestamps: true, versionKey: 'v' }
);

UserSchema.index({ username: 1 }, { unique: true });

export type UserDoc = InferSchemaType<typeof UserSchema> & mongoose.Document;
export const UserModel = mongoose.model('User', UserSchema);
