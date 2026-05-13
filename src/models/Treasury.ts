import mongoose, { Schema, Document } from 'mongoose';

export interface ITreasury extends Document {
  /** Total accumulated commissions in sats */
  accumulated: number;
  /** Total withdrawn in sats */
  withdrawn: number;
  /** Available balance in sats */
  balance: number;
  /** Lightning address for receiving commissions */
  lightningAddress: string;
  /** BTC on-chain fallback address */
  btcAddress: string;
  createdAt: Date;
  updatedAt: Date;
}

const treasurySchema = new Schema<ITreasury>(
  {
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
    lightningAddress: {
      type: String,
      default: '',
    },
    btcAddress: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  },
);

export const Treasury = mongoose.model<ITreasury>('Treasury', treasurySchema);
