import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { config } from '../utils/config';
import { User } from './User';
import { Swap } from './Swap';
import { Raffle } from './Raffle';

export { User, Swap, Raffle };
export type { IUser } from './User';
export type { ISwap, SwapDirection, SwapStatus } from './Swap';
export type { IRaffle } from './Raffle';

export async function connectDatabase(): Promise<void> {
  try {
    await mongoose.connect(config.mongoUri);
    logger.info(`Connected to MongoDB at ${config.mongoUri}`);
  } catch (error) {
    logger.error('Failed to connect to MongoDB', { error });
    throw error;
  }
}

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB disconnected');
});

mongoose.connection.on('error', (err) => {
  logger.error('MongoDB connection error', { error: err });
});
