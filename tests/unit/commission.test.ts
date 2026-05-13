import { expect } from 'chai';
import { CommissionEngine } from '../../src/engine/commission';

describe('CommissionEngine', () => {
  let engine: CommissionEngine;

  beforeEach(() => {
    engine = new CommissionEngine(2.5);
  });

  describe('calculateCommission', () => {
    it('should calculate commission (percentage based, in smallest units)', () => {
      expect(engine.calculateCommission(10000)).to.equal(250);
      expect(engine.calculateCommission(0)).to.equal(0);
      expect(engine.calculateCommission(100000000)).to.equal(2500000);
    });

    it('should floor the commission amount', () => {
      expect(engine.calculateCommission(9999)).to.equal(249);
    });
  });

  describe('getNetAfterCommission', () => {
    it('should return amount minus commission', () => {
      expect(engine.getNetAfterCommission(10000)).to.equal(9750);
    });
  });

  describe('calculateFeeBreakdown', () => {
    const mockRateInfo = {
      boltzRate: 1,
      userRate: 0.975,
      boltzFeePct: 0.5,
      boltzMinerFee: 302,
      botCommissionPct: 2.5,
      botCommissionAmount: 0,
      minAmount: 25000,
      maxAmount: 25000000,
      pairHash: 'test-hash',
    };

    it('should calculate full breakdown', () => {
      const fee = engine.calculateFeeBreakdown(1000000, mockRateInfo);

      expect(fee.sourceAmount).to.equal(1000000);
      expect(fee.commissionRate).to.equal(2.5);
      expect(fee.commissionAmount).to.equal(25000);
      expect(fee.boltzFeeRate).to.equal(0.5);
      expect(fee.totalFees).to.be.greaterThan(fee.commissionAmount);
      expect(fee.netSwapAmount).to.be.lessThan(1000000);
      expect(fee.estimatedReceive).to.be.greaterThan(0);
      expect(fee.botProfit).to.equal(fee.commissionAmount);
    });

    it('should handle zero amount', () => {
      const fee = engine.calculateFeeBreakdown(0, mockRateInfo);
      expect(fee.commissionAmount).to.equal(0);
      expect(fee.estimatedReceive).to.equal(0);
    });
  });

  describe('formatAmount', () => {
    it('should format sats/BTC', () => {
      const result = engine.formatAmount(100000000, 'sats');
      expect(result).to.include('sats');
      expect(result).to.include('1.00000000 BTC');
    });

    it('should format USDT', () => {
      const result = engine.formatAmount(25000, 'USDT');
      expect(result).to.include('250.00');
      expect(result).to.include('USDT');
    });
  });

  describe('isProfitable', () => {
    it('should return false for tiny amounts', () => {
      expect(engine.isProfitable(1, 0.10)).to.be.false;
    });

    it('should return true for reasonable amounts', () => {
      expect(engine.isProfitable(100000, 0.10)).to.be.true;
    });
  });

  describe('setCommissionRate', () => {
    it('should accept rate within 1.5-2.5', () => {
      engine.setCommissionRate(1.8);
      expect(engine.getCommissionRate()).to.equal(1.8);
    });

    it('should reject rate below 1.5', () => {
      expect(() => engine.setCommissionRate(0.5)).to.throw('1.5% and 2.5%');
    });

    it('should reject rate above 2.5', () => {
      expect(() => engine.setCommissionRate(5)).to.throw('1.5% and 2.5%');
    });

    it('should accept boundary values', () => {
      engine.setCommissionRate(1.5);
      expect(engine.getCommissionRate()).to.equal(1.5);
      engine.setCommissionRate(2.5);
      expect(engine.getCommissionRate()).to.equal(2.5);
    });
  });
});
