import mongoose, { Schema, Document } from 'mongoose';

export type SwapDirection =
  | 'USDT2BTC'
  | 'BTC2USDT'
  | 'USDC2BTC'
  | 'BTC2USDC'
  | 'LN2ONCHAIN'
  | 'ONCHAIN2LN';

export type SwapStatus = 'pending' | 'completed' | 'failed' | 'refunded';

export interface ISwap extends Document {
  swapId: string;
  userId: string;
  direction: SwapDirection;
  sourceAmount: number;
  destAmount: number;
  sourceCurrency: string;
  destCurrency: string;
  boltzSwapId: string;
  boltzStatus: string;
  commissionRate: number;
  commissionAmount: number;
  botProfit: number;
  status: SwapStatus;
  createdAt: Date;
  completedAt?: Date;
}

const swapSchema = new Schema<ISwap>(
  {
    swapId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    direction: {
      type: String,
      required: true,
      enum: ['USDT2BTC', 'BTC2USDT', 'USDC2BTC', 'BTC2USDC', 'LN2ONCHAIN', 'ONCHAIN2LN'],
    },
    sourceAmount: {
      type: Number,
      required: true,
    },
    destAmount: {
      type: Number,
      required: true,
    },
    sourceCurrency: {
      type: String,
      required: true,
    },
    destCurrency: {
      type: String,
      required: true,
    },
    boltzSwapId: {
      type: String,
      default: '',
    },
    boltzStatus: {
      type: String,
      default: 'pending',
    },
    commissionRate: {
      type: Number,
      required: true,
    },
    commissionAmount: {
      type: Number,
      required: true,
    },
    botProfit: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'completed', 'failed', 'refunded'],
      default: 'pending',
    },
    completedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  },
);

export const Swap = mongoose.model<ISwap>('Swap', swapSchema);
