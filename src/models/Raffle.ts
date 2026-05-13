import mongoose, { Schema, Document } from 'mongoose';

export interface IRaffle extends Document {
  weekNumber: number;
  /** Prize pool in sats */
  prizePool: number;
  /** Total volume in sats */
  totalVolume: number;
  participants: number;
  winnerId?: string;
  winnerUsername?: string;
  drawAt?: Date;
  paid: boolean;
  txHash?: string;
  createdAt: Date;
}

const raffleSchema = new Schema<IRaffle>(
  {
    weekNumber: {
      type: Number,
      required: true,
      unique: true,
      index: true,
    },
    prizePool: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: Number.isInteger,
    },
    totalVolume: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: Number.isInteger,
    },
    participants: {
      type: Number,
      required: true,
      default: 0,
    },
    winnerId: {
      type: String,
    },
    winnerUsername: {
      type: String,
    },
    drawAt: {
      type: Date,
    },
    paid: {
      type: Boolean,
      default: false,
    },
    txHash: {
      type: String,
    },
  },
  {
    timestamps: true,
  },
);

export const Raffle = mongoose.model<IRaffle>('Raffle', raffleSchema);
