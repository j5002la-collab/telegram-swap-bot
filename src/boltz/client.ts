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

class BoltzClient {
  private http: AxiosInstance;
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.http = axios.create({
      baseURL: `${this.baseUrl}/v2`,
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // --- Pairs ---

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

  // --- Submarine Swap (Chain → Lightning) ---

  async createSubmarineSwap(
    params: SubmarineSwapRequest,
  ): Promise<SubmarineSwapResponse> {
    logger.info('Creating submarine swap', { from: params.from, to: params.to });
    const { data } = await this.http.post<SubmarineSwapResponse>(
      '/swap/submarine',
      params,
    );
    logger.info('Submarine swap created', { swapId: data.id });
    return data;
  }

  async getSubmarineSwapClaimDetails(swapId: string) {
    const { data } = await this.http.get(`/swap/submarine/${swapId}/claim`);
    return data;
  }

  async sendSubmarineSwapClaimSignature(
    swapId: string,
    params: { pubNonce: string; partialSignature: string },
  ) {
    const { data } = await this.http.post(
      `/swap/submarine/${swapId}/claim`,
      params,
    );
    return data;
  }

  // --- Reverse Swap (Lightning → Chain) ---

  async createReverseSwap(
    params: ReverseSwapRequest,
  ): Promise<ReverseSwapResponse> {
    logger.info('Creating reverse swap', { from: params.from, to: params.to });
    const { data } = await this.http.post<ReverseSwapResponse>(
      '/swap/reverse',
      params,
    );
    logger.info('Reverse swap created', { swapId: data.id });
    return data;
  }

  async getReverseSwapClaimDetails(swapId: string) {
    const { data } = await this.http.get(`/swap/reverse/${swapId}/claim`);
    return data;
  }

  async sendReverseSwapClaimSignature(
    swapId: string,
    params: { preimage: string; pubNonce: string; partialSignature: string },
  ) {
    const { data } = await this.http.post(
      `/swap/reverse/${swapId}/claim`,
      params,
    );
    return data;
  }

  // --- Chain Swap (Chain ↔ Chain) ---

  async createChainSwap(params: ChainSwapRequest): Promise<ChainSwapResponse> {
    logger.info('Creating chain swap', { from: params.from, to: params.to });
    const { data } = await this.http.post<ChainSwapResponse>('/swap/chain', params);
    logger.info('Chain swap created', { swapId: data.lockupAddress });
    return data;
  }

  async getChainSwapClaimDetails(swapId: string) {
    const { data } = await this.http.get(`/swap/chain/${swapId}/claim`);
    return data;
  }

  // --- General ---

  getWebSocketUrl(): string {
    // WebSocket is on separate port in development, but same host
    const base = this.baseUrl.replace(/\/api$/, '').replace(/:\d+/, '');
    const wsBase = config.boltzApiUrl.startsWith('https')
      ? config.boltzApiUrl.replace('https://', 'wss://')
      : config.boltzApiUrl.replace('http://', 'ws://');
    return `${wsBase}/v2/ws`;
  }
}

export const boltzClient = new BoltzClient(config.boltzApiUrl);
