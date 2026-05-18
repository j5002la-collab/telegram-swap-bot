import axios, { AxiosInstance } from 'axios';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import type {
  SubmarineSwapRequest,
  SubmarineSwapResponse,
  ReverseSwapRequest,
  ReverseSwapResponse,
  ChainSwapRequest,
  ChainSwapResponse,
  SubmarinePairs,
  ReversePairs,
  ChainPairs,
} from './types';

export class BoltzClient {
  private http: AxiosInstance;
  private baseUrl: string;
  private proEnabled = false;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.http = axios.create({
      baseURL: `${this.baseUrl}/v2`,
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    });

    // Debug: log all Boltz API calls
    this.http.interceptors.request.use((req) => {
      logger.debug('Boltz API →', { method: req.method?.toUpperCase(), url: req.url });
      return req;
    });
    this.http.interceptors.response.use(
      (res) => {
        logger.debug('Boltz API ←', { status: res.status, url: res.config.url, ms: Date.now() - Number(res.config.headers?.['x-start'] || Date.now()) });
        return res;
      },
      (err) => {
        logger.error('Boltz API ✗', { url: err.config?.url, status: err.response?.status, data: err.response?.data, message: err.message });
        return Promise.reject(err);
      },
    );
  }

  // --- Pro Mode ---
  enablePro(): void {
    this.proEnabled = true;
    logger.info('Boltz Pro mode enabled');
  }

  disablePro(): void {
    this.proEnabled = false;
    logger.info('Boltz Pro mode disabled');
  }

  isProEnabled(): boolean {
    return this.proEnabled;
  }

  private proHeaders(): Record<string, string> {
    return this.proEnabled ? { Referral: 'pro' } : {};
  }

  // --- Pairs (always regular mode for accurate limits) ---
  // Pro mode only affects swap creation, not pair fetching.
  // Submarine Pro pairs have 1M sat minimum vs 25k regular.
  async getSubmarinePairs(): Promise<SubmarinePairs> {
    const { data } = await this.http.get<SubmarinePairs>('/swap/submarine');
    return data;
  }

  async getReversePairs(): Promise<ReversePairs> {
    const { data } = await this.http.get<ReversePairs>('/swap/reverse');
    return data;
  }

  async getChainPairs(): Promise<ChainPairs> {
    const { data } = await this.http.get<ChainPairs>('/swap/chain');
    return data;
  }

  /** Retry helper with exponential backoff */
  private async retry<T>(fn: () => Promise<T>, label: string, maxRetries = 2): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const isTimeout = err?.code === 'ETIMEDOUT' || err?.code === 'ECONNABORTED';
        if (attempt < maxRetries && isTimeout) {
          const delay = (attempt + 1) * 5000; // 5s, 10s
          logger.warn(`Boltz ${label} timeout, retrying`, { attempt: attempt + 1, delayMs: delay });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error('unreachable');
  }

  // --- Submarine Swap ---
  // Pro mode has 1M sat minimum for submarine — disable it for user swaps
  async createSubmarineSwap(params: SubmarineSwapRequest): Promise<SubmarineSwapResponse> {
    logger.info('Creating submarine swap [regular]', { from: params.from, to: params.to });
    const data = await this.retry(async () => {
      const res = await this.http.post<SubmarineSwapResponse>('/swap/submarine', params);
      return res.data;
    }, 'submarine');
    logger.info('Submarine swap created', { swapId: data.id });
    return data;
  }

  // --- Reverse Swap ---
  async createReverseSwap(params: ReverseSwapRequest): Promise<ReverseSwapResponse> {
    const body = this.proEnabled ? { ...params, referralId: 'pro' } : params;
    logger.info(`Creating reverse swap [pro=${this.proEnabled}]`);
    const { data } = await this.http.post<ReverseSwapResponse>('/swap/reverse', body);
    logger.info('Reverse swap created', { swapId: data.id, pro: this.proEnabled });
    return data;
  }

  // --- Chain Swap ---
  async createChainSwap(params: ChainSwapRequest): Promise<ChainSwapResponse> {
    const body = this.proEnabled ? { ...params, referralId: 'pro' } : params;
    logger.info(`Creating chain swap [pro=${this.proEnabled}]`);
    const { data } = await this.http.post<ChainSwapResponse>('/swap/chain', body);
    return data;
  }

  // --- Claim details (same endpoints) ---
  async getSubmarineSwapClaimDetails(swapId: string) {
    const { data } = await this.http.get(`/swap/submarine/${swapId}/claim`);
    return data;
  }

  /** Get swap status by ID via REST (GET /v2/swap/:id) */
  async getSwapStatus(swapId: string): Promise<string> {
    try {
      const { data } = await this.http.get(`/swap/${swapId}`);
      return data.status || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async sendSubmarineSwapClaimSignature(swapId: string, params: { pubNonce: string; partialSignature: string }) {
    const { data } = await this.http.post(`/swap/submarine/${swapId}/claim`, params);
    return data;
  }

  async getReverseSwapClaimDetails(swapId: string) {
    const { data } = await this.http.get(`/swap/reverse/${swapId}/claim`);
    return data;
  }

  async sendReverseSwapClaimSignature(swapId: string, params: { preimage: string; pubNonce: string; partialSignature: string }) {
    const { data } = await this.http.post(`/swap/reverse/${swapId}/claim`, params);
    return data;
  }

  async getChainSwapClaimDetails(swapId: string) {
    const { data } = await this.http.get(`/swap/chain/${swapId}/claim`);
    return data;
  }

  getWebSocketUrl(): string {
    const base = this.baseUrl.replace(/\/api$/, '').replace(/:\d+/, '');
    const wsBase = config.boltzApiUrl.startsWith('https')
      ? config.boltzApiUrl.replace('https://', 'wss://')
      : config.boltzApiUrl.replace('http://', 'ws://');
    return `${wsBase}/v2/ws`;
  }
}

export const boltzClient = new BoltzClient(config.boltzApiUrl);
