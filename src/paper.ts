export type Side = 'buy' | 'sell';
export interface Print { block: number; price: number; size: number; side: Side }
export interface Order { side: Side; price: number; remaining: number; activeAfter: number }
export interface Assumptions { gasMon: number; feeBps: number; participation: number }
/** Cash-funded spot simulation. No borrowing or implicit short sales. */
export class PaperAccount {
  cash: number;
  mon: number;
  basis: number;
  realized = 0;
  gasUsd = 0;
  feeUsd = 0;
  orders = 0;
  fills = 0;
  turnoverUsd = 0;
  peak: number;
  maxDrawdownUsd = 0;
  order: Order | null = null;
  constructor(readonly initialUsd: number, readonly initialMid: number, readonly costs: Assumptions) {
    this.cash = initialUsd / 2;
    this.mon = initialUsd / 2 / initialMid;
    this.basis = initialMid;
    this.peak = initialUsd;
  }
  quote(side: Side, price: number, size: number, activeAfter: number, mid: number) {
    if (![price, size, mid].every(x => Number.isFinite(x) && x > 0)) throw new Error('Invalid quote');
    // Identical outstanding orders are retained, avoiding pointless cancel/replace costs.
    if (this.order?.side === side && this.order.price === price && this.order.remaining === size) return false;
    const gas = this.costs.gasMon * mid;
    const available = side === 'buy' ? this.cash - gas >= size * price * (1 + this.costs.feeBps / 10000) : this.mon >= size && this.cash >= gas;
    if (!available) return false;
    this.order = { side, price, remaining: size, activeAfter };
    this.cash -= gas;
    this.gasUsd += gas;
    this.orders++;
    return true;
  }
  consume(p: Print) {
    const o = this.order;
    if (!o || p.block <= o.activeAfter) return 0;
    // Strict trade-through: a print at our exact price is NOT sufficient evidence of a fill.
    if (!(o.side === 'buy' ? p.side === 'sell' && p.price < o.price : p.side === 'buy' && p.price > o.price)) return 0;
    const size = Math.min(o.remaining, p.size * this.costs.participation);
    if (size <= 0) return 0;
    const value = size * o.price, fee = value * this.costs.feeBps / 10000;
    if (o.side === 'buy') {
      this.basis = (this.basis * this.mon + value) / (this.mon + size);
      this.cash -= value + fee; this.mon += size;
    } else {
      this.realized += size * (o.price - this.basis);
      this.cash += value - fee; this.mon -= size;
    }
    this.feeUsd += fee; this.turnoverUsd += value; this.fills++;
    o.remaining -= size;
    if (o.remaining < 1e-8) this.order = null;
    return size;
  }
  metrics(mid: number) {
    const equity = this.cash + this.mon * mid;
    this.peak = Math.max(this.peak, equity);
    this.maxDrawdownUsd = Math.max(this.maxDrawdownUsd, this.peak - equity);
    const holdEquity = this.initialUsd / 2 + this.initialUsd / 2 / this.initialMid * mid;
    return { equityUsd: equity, netBeforeHostingUsd: equity - this.initialUsd,
      grossTradingPnlUsd: equity - this.initialUsd + this.gasUsd + this.feeUsd,
      realizedGrossUsd: this.realized, unrealizedGrossUsd: this.mon * (mid - this.basis),
      estimatedGasUsd: this.gasUsd, estimatedExchangeFeesUsd: this.feeUsd,
      holdPnlUsd: holdEquity - this.initialUsd, excessVsHoldUsd: equity - holdEquity,
      cashUsd: this.cash, inventoryMon: this.mon, inventoryUsd: this.mon * mid,
      maxDrawdownUsd: this.maxDrawdownUsd, orders: this.orders, fills: this.fills,
      turnoverUsd: this.turnoverUsd };
  }
}
