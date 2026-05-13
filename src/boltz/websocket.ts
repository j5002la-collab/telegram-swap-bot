import WebSocket from 'ws';
import { logger } from '../utils/logger';
import type { BoltzSwapStatus } from './types';

export type SwapStatusCallback = (swapId: string, status: BoltzSwapStatus) => void;
export type WsErrorCallback = (error: Error) => void;

interface Subscription {
  id: string;
  callback: SwapStatusCallback;
}

export class BoltzWebSocket {
  private ws: WebSocket | null = null;
  private url: string;
  private subscriptions: Map<string, Subscription> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelayMs = 1000;
  private running = false;
  private onError?: WsErrorCallback;

  constructor(url: string, onError?: WsErrorCallback) {
    this.url = url;
    this.onError = onError;
  }

  async connect(): Promise<void> {
    this.running = true;
    await this.createConnection();
  }

  private createConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      let connected = false;

      this.ws.on('open', () => {
        logger.info('WebSocket connected to Boltz');
        connected = true;
        this.reconnectAttempts = 0;

        // Resubscribe to all existing subscriptions
        for (const [swapId, sub] of this.subscriptions) {
          this.sendSubscribe(swapId);
        }

        resolve();
      });

      this.ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          if (msg.event === 'update' && msg.args?.[0]) {
            const update = msg.args[0];
            const sub = this.subscriptions.get(update.id);
            if (sub) {
              logger.debug('WebSocket swap update', {
                swapId: update.id,
                status: update.status,
              });
              sub.callback(update.id, update.status);
            }
          }
        } catch (err) {
          logger.error('WebSocket message parse error', { error: err });
        }
      });

      this.ws.on('close', (code) => {
        logger.warn('WebSocket disconnected', { code });
        if (this.running && !connected) {
          reject(new Error(`WebSocket connection failed: code ${code}`));
        }
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        logger.error('WebSocket error', { error: err.message });
        if (!connected) {
          reject(err);
        }
        this.onError?.(err);
      });
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max WebSocket reconnect attempts reached');
      return;
    }

    const delay = this.reconnectDelayMs * Math.pow(1.5, this.reconnectAttempts);
    this.reconnectAttempts++;

    logger.info('Scheduling WebSocket reconnect', {
      attempt: this.reconnectAttempts,
      delayMs: Math.round(delay),
    });

    setTimeout(() => {
      if (this.running) {
        this.createConnection().catch((err) => {
          logger.error('WebSocket reconnect failed', { error: err.message });
        });
      }
    }, delay);
  }

  subscribe(swapId: string, callback: SwapStatusCallback): void {
    this.subscriptions.set(swapId, { id: swapId, callback });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(swapId);
    }
  }

  unsubscribe(swapId: string): void {
    this.subscriptions.delete(swapId);
  }

  private sendSubscribe(swapId: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        op: 'subscribe',
        channel: 'swap.update',
        args: [swapId],
      }),
    );
  }

  disconnect(): void {
    this.running = false;
    this.ws?.close();
    this.ws = null;
    logger.info('WebSocket disconnected cleanly');
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
