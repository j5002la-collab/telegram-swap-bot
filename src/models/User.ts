import mongoose, { Schema, Document } from 'mongoose';

export interface IUser extends Document {
  telegramId: string;
  username: string;
  firstName: string;
  firstSeen: Date;
  lastSeen: Date;
  swapsCount: number;
  /** Total swap volume in sats (or cents for USDT/USDC) */
  totalVolume: number;
  raffleTickets: number;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    telegramId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    username: {
      type: String,
      default: '',
    },
    firstName: {
      type: String,
      default: '',
    },
    firstSeen: {
      type: Date,
      default: Date.now,
    },
    lastSeen: {
      type: Date,
      default: Date.now,
    },
    swapsCount: {
      type: Number,
      default: 0,
    },
    totalVolume: {
      type: Number,
      default: 0,
      min: 0,
      validate: Number.isInteger,
    },
    raffleTickets: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  },
);

export const User = mongoose.model<IUser>('User', userSchema);
