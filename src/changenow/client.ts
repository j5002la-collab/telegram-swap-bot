import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';

// ChangeNOW API types
export interface CNCurrency {
  ticker: string;
  name: string;
  network: string;
  hasExternalId: boolean;
  isFiat: boolean;
  isStable: boolean;
}

export interface CNEstimateResponse {
  estimatedAmount?: string;
  toAmount?: string;
  fromAmount?: number;
  rateId: string;
  validUntil: string;
  transactionSpeedForecast: string;
  warningMessage: string | null;
}

export interface CNCreateRequest {
  fromCurrency: string;
  toCurrency: string;
  fromNetwork?: string;
  toNetwork?: string;
  fromAmount: string;
  toAmount: string;
  address: string;
  flow: 'fixed-rate';
  rateId: string;
  extraId?: string;
}

export interface CNCreateResponse {
  id: string;
  payinAddress: string;
  payoutAddress: string;
  fromCurrency: string;
  toCurrency: string;
  amount: {
    from: string;
    to: string;
  };
  status: string;
}

export type CNStatus = 'waiting' | 'confirming' | 'exchanging' | 'sending' | 'finished' | 'failed' | 'refunded';

export interface CNStatusResponse {
  id: string;
  status: CNStatus;
  payinHash?: string;
  payoutHash?: string;
}

// Network → { ticker, network } mapping for ChangeNOW v2
// ChangeNOW v2 requires separate fromNetwork/toNetwork params, NOT legacy tickers
export const USDT_NETWORKS: Record<string, { ticker: string; network: string }> = {
  'TRC-20':    { ticker: 'usdt', network: 'trc20' },
  'ERC-20':    { ticker: 'usdt', network: 'eth' },
  'BEP-20':    { ticker: 'usdt', network: 'bsc' },
  'ARBITRUM':  { ticker: 'usdt', network: 'arbitrum' },
  'SOLANA':    { ticker: 'usdt', network: 'sol' },
  'POLYGON':   { ticker: 'usdt', network: 'matic' },
  'OPTIMISM':  { ticker: 'usdt', network: 'op' },
  'AVALANCHE': { ticker: 'usdt', network: 'avaxc' },
  'BASE':      { ticker: 'usdt', network: 'base' },
};

export const USDC_NETWORKS: Record<string, { ticker: string; network: string }> = {
  'ERC-20':    { ticker: 'usdc', network: 'eth' },
  'ARBITRUM':  { ticker: 'usdc', network: 'arbitrum' },
  'BASE':      { ticker: 'usdc', network: 'base' },
  'SOLANA':    { ticker: 'usdc', network: 'sol' },
  'POLYGON':   { ticker: 'usdc', network: 'matic' },
  'OPTIMISM':  { ticker: 'usdc', network: 'op' },
  'AVALANCHE': { ticker: 'usdc', network: 'avaxc' },
};

export class ChangeNowClient {
  private http: AxiosInstance;
  private baseUrl = 'https://api.changenow.io/v2';

  constructor(apiKey: string) {
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      headers: {
        'x-changenow-api-key': apiKey,
        'Content-Type': 'application/json',
      },
    });

    // Debug: log all ChangeNOW API calls
    this.http.interceptors.request.use((req) => {
      logger.debug('ChangeNOW API →', { method: req.method?.toUpperCase(), url: req.url });
      return req;
    });
    this.http.interceptors.response.use(
      (res) => {
        logger.debug('ChangeNOW API ←', { status: res.status, url: res.config.url });
        return res;
      },
      (err) => {
        logger.error('ChangeNOW API ✗', { url: err.config?.url, status: err.response?.status, message: err.message });
        return Promise.reject(err);
      },
    );
  }

  async getCurrencies(flow: 'fixed-rate' | 'standard' = 'fixed-rate'): Promise<CNCurrency[]> {
    const { data } = await this.http.get('/exchange/currencies', { params: { flow, active: true } });
    return data;
  }

  async getMinAmount(fromCurrency: string, toCurrency: string, fromNetwork?: string, toNetwork?: string): Promise<string> {
    const params: Record<string, string> = { fromCurrency, toCurrency, flow: 'fixed-rate' };
    if (fromNetwork) params.fromNetwork = fromNetwork;
    if (toNetwork) params.toNetwork = toNetwork;
    const { data } = await this.http.get('/exchange/min-amount', { params });
    return data.minAmount;
  }

  async estimate(fromCurrency: string, toCurrency: string, fromAmount: string, fromNetwork?: string, toNetwork?: string): Promise<CNEstimateResponse> {
    const params: Record<string, string> = { fromCurrency, toCurrency, fromAmount, flow: 'fixed-rate' };
    if (fromNetwork) params.fromNetwork = fromNetwork;
    if (toNetwork) params.toNetwork = toNetwork;
    const { data } = await this.http.get('/exchange/estimated-amount', { params });
    return data;
  }

  async createExchange(params: CNCreateRequest): Promise<CNCreateResponse> {
    logger.info('Creating ChangeNOW exchange', {
      from: params.fromCurrency,
      to: params.toCurrency,
      amount: params.fromAmount,
    });
    const { data } = await this.http.post('/exchange', params);
    logger.info('ChangeNOW exchange created', { id: data.id });
    return data;
  }

  async getStatus(id: string): Promise<CNStatusResponse> {
    const { data } = await this.http.get('/exchange/by-id', { params: { id } });
    return data;
  }

  /** Map our internal chain ID to ChangeNOW { ticker, network } pair */
  getTicker(currency: 'USDT' | 'USDC', network: string): { ticker: string; network: string } | null {
    if (currency === 'USDT') return USDT_NETWORKS[network] || null;
    if (currency === 'USDC') return USDC_NETWORKS[network] || null;
    return null;
  }

  /** BTC destination network */
  getBTCDest(): { ticker: string; network: string } {
    return { ticker: 'btc', network: 'btc' };
  }
}

let cnClient: ChangeNowClient | null = null;

export function getCNClient(): ChangeNowClient | null {
  return cnClient;
}

export function initCNClient(apiKey: string): ChangeNowClient {
  cnClient = new ChangeNowClient(apiKey);
  logger.info('ChangeNOW client initialized');
  return cnClient;
}
