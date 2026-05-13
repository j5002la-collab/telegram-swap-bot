import mongoose, { Schema, Document } from 'mongoose';

export type CurrencyType = 'BTC' | 'USDT' | 'USDC';

export interface ITreasury extends Document {
  currency: CurrencyType;
  /** Accumulated earnings in smallest unit (sats or cents) */
  accumulated: number;
  /** Total withdrawn in smallest unit */
  withdrawn: number;
  /** Balance available (accumulated - withdrawn) */
  balance: number;
  /** Admin wallet address for this currency */
  walletAddress: string;
  createdAt: Date;
  updatedAt: Date;
}

const treasurySchema = new Schema<ITreasury>(
  {
    currency: {
      type: String,
      required: true,
      enum: ['BTC', 'USDT', 'USDC'],
      unique: true,
    },
    accumulated: {
      type: Number,
      default: 0,
      min: 0,
      validate: Number.isInteger,
    },
    withdrawn: {
      type: Number,
      default: 0,
      min: 0,
      validate: Number.isInteger,
    },
    balance: {
      type: Number,
      default: 0,
      min: 0,
      validate: Number.isInteger,
    },
    walletAddress: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  },
);

export const Treasury = mongoose.model<ITreasury>('Treasury', treasurySchema);
