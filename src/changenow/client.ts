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
  estimatedAmount: string;
  rateId: string;
  validUntil: string;
  transactionSpeedForecast: string;
  warningMessage: string | null;
}

export interface CNCreateRequest {
  fromCurrency: string;
  toCurrency: string;
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

// Network → ChangeNOW ticker mapping
export const USDT_NETWORKS: Record<string, string> = {
  'TRC-20': 'usdttrc',
  'ERC-20': 'usdterc20',
  'BEP-20': 'usdtbsc',
  'ARBITRUM': 'usdtarbitrum',
  'SOLANA': 'usdtsol',
  'POLYGON': 'usdtmatic',
  'OPTIMISM': 'usdtop',
  'AVALANCHE': 'usdtavaxc',
  'BASE': 'usdtbase',
};

export const USDC_NETWORKS: Record<string, string> = {
  'ERC-20': 'usdcerc20',
  'ARBITRUM': 'usdcarbitrum',
  'BASE': 'usdcbase',
  'SOLANA': 'usdcsol',
  'POLYGON': 'usdcpolygon',
  'OPTIMISM': 'usdcop',
  'AVALANCHE': 'usdcavaxc',
};

export class ChangeNowClient {
  private http: AxiosInstance;
  private baseUrl = 'https://api.changenow.io/v2';

  constructor(apiKey: string) {
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 15000,
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
    });
  }

  async getCurrencies(flow: 'fixed-rate' | 'standard' = 'fixed-rate'): Promise<CNCurrency[]> {
    const { data } = await this.http.get('/exchange/currencies', { params: { flow, active: true } });
    return data;
  }

  async getMinAmount(fromCurrency: string, toCurrency: string): Promise<string> {
    const { data } = await this.http.get('/exchange/min-amount', {
      params: { fromCurrency, toCurrency, flow: 'fixed-rate' },
    });
    return data.minAmount;
  }

  async estimate(fromCurrency: string, toCurrency: string, fromAmount: string): Promise<CNEstimateResponse> {
    const { data } = await this.http.get('/exchange/estimated-amount', {
      params: { fromCurrency, toCurrency, fromAmount, flow: 'fixed-rate' },
    });
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

  /** Map our internal chain ID to ChangeNOW ticker */
  getTicker(currency: 'USDT' | 'USDC', network: string): string | null {
    if (currency === 'USDT') return USDT_NETWORKS[network] || null;
    if (currency === 'USDC') return USDC_NETWORKS[network] || null;
    return null;
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
