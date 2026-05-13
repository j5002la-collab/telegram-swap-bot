import crypto from 'crypto';
import { logger } from '../utils/logger';
import { User, Raffle } from '../models';
import { commissionEngine } from './commission';

export interface RaffleResult {
  weekNumber: number;
  prizePool: number;
  totalVolume: number;
  participants: number;
  winnerId: string;
  winnerUsername: string;
  winnerTickets: number;
  drawAt: Date;
}

export class RaffleEngine {
  /**
   * Calculate the current week number (ISO week).
   */
  getCurrentWeekNumber(): number {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    const days = Math.floor((now.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
    return Math.ceil((days + start.getDay() + 1) / 7);
  }

  /**
   * Get the current week's raffle or create it.
   */
  async getOrCreateCurrentRaffle() {
    const weekNumber = this.getCurrentWeekNumber();
    let raffle = await Raffle.findOne({ weekNumber });

    if (!raffle) {
      raffle = await Raffle.create({
        weekNumber,
        prizePool: 0,
        totalVolume: 0,
        participants: 0,
        paid: false,
      });
      logger.info('Created new raffle', { weekNumber });
    }

    return raffle;
  }

  /**
   * Update weekly raffle stats for a user who just completed a swap.
   */
  async trackSwapVolume(userId: string, volumeInSats: number): Promise<void> {
    try {
      // Update user's weekly tickets
      await User.findOneAndUpdate(
        { telegramId: userId },
        { $inc: { raffleTickets: 1 } },
      );

      // Update raffle pool
      const raffle = await this.getOrCreateCurrentRaffle();
      const prizeAddition = Math.floor(volumeInSats * 0.001); // 0.1%

      raffle.totalVolume += volumeInSats;
      raffle.prizePool += prizeAddition;

      // Count unique participants
      const participantCount = await User.countDocuments({
        raffleTickets: { $gt: 0 },
      });
      raffle.participants = participantCount;
      await raffle.save();

      logger.debug('Raffle tracking updated', {
        week: raffle.weekNumber,
        prizePool: raffle.prizePool,
        participants: raffle.participants,
      });
    } catch (error) {
      logger.error('Failed to track raffle swap', { error });
    }
  }

  /**
   * Execute the weekly raffle draw.
   * Returns the winner and pays them via the callback.
   */
  async executeDraw(
    onWinner: (result: RaffleResult) => Promise<void>,
  ): Promise<RaffleResult | null> {
    const raffle = await this.getOrCreateCurrentRaffle();

    if (raffle.paid) {
      logger.info('Raffle already drawn this week', { weekNumber: raffle.weekNumber });
      return null;
    }

    if (raffle.participants === 0) {
      logger.info('No participants for weekly raffle', { weekNumber: raffle.weekNumber });
      return null;
    }

    // Get all participants with tickets, weighted by ticket count
    const users = await User.find({
      raffleTickets: { $gt: 0 },
    }).select('telegramId username raffleTickets');

    if (users.length === 0) {
      logger.info('No eligible users for raffle draw');
      return null;
    }

    // Weighted random selection
    const entries: { userId: string; username: string; tickets: number }[] = [];
    for (const user of users) {
      for (let i = 0; i < user.raffleTickets; i++) {
        entries.push({
          userId: user.telegramId,
          username: user.username,
          tickets: user.raffleTickets,
        });
      }
    }

    // Cryptographic random selection
    const randomIndex = crypto.randomInt(0, entries.length);
    const winner = entries[randomIndex];

    logger.info('Raffle winner selected', {
      weekNumber: raffle.weekNumber,
      winner: winner.username,
      ticketCount: winner.tickets,
      entries: entries.length,
      prizePool: raffle.prizePool,
    });

    // Update raffle
    raffle.winnerId = winner.userId;
    raffle.winnerUsername = winner.username;
    raffle.drawAt = new Date();
    raffle.paid = true;
    await raffle.save();

    // Reset tickets for next week
    await User.updateMany({}, { $set: { raffleTickets: 0 } });

    const result: RaffleResult = {
      weekNumber: raffle.weekNumber,
      prizePool: raffle.prizePool,
      totalVolume: raffle.totalVolume,
      participants: raffle.participants,
      winnerId: winner.userId,
      winnerUsername: winner.username,
      winnerTickets: winner.tickets,
      drawAt: raffle.drawAt,
    };

    // Callback to pay the winner
    try {
      await onWinner(result);
    } catch (error) {
      logger.error('Failed to pay raffle winner', { error, winner: winner.username });
    }

    return result;
  }

  /**
   * Get raffle status for display.
   */
  async getRaffleStatus(): Promise<{
    weekNumber: number;
    prizePool: number;
    totalVolume: number;
    participants: number;
    paid: boolean;
    lastWinner?: string;
    lastDrawAt?: Date;
  } | null> {
    const raffle = await this.getOrCreateCurrentRaffle();
    if (!raffle) return null;

    // Get last week's winner
    const lastRaffle = await Raffle.findOne({
      weekNumber: raffle.weekNumber - 1,
      paid: true,
    }).sort({ drawAt: -1 });

    return {
      weekNumber: raffle.weekNumber,
      prizePool: raffle.prizePool,
      totalVolume: raffle.totalVolume,
      participants: raffle.participants,
      paid: raffle.paid,
      lastWinner: lastRaffle?.winnerUsername,
      lastDrawAt: lastRaffle?.drawAt,
    };
  }
}

export const raffleEngine = new RaffleEngine();
