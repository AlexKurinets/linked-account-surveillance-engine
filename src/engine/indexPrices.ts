import { HOUR } from "../util.js";

/**
 * Recent index prices per contract, answering "what was the index at time t".
 * The reference feed is the highest-volume input, so it is held in sorted
 * arrays and trimmed to a rolling window rather than queried per fill.
 */
export class IndexPrices {
  private series = new Map<string, { ts: number[]; px: number[] }>();
  constructor(private keepMs = 6 * HOUR) {}

  add(contract: string, ts: number, price: number): void {
    let s = this.series.get(contract);
    if (!s) {
      s = { ts: [], px: [] };
      this.series.set(contract, s);
    }
    const n = s.ts.length;
    if (n && ts < s.ts[n - 1]) {
      // rare out-of-order tick: insert in place
      let i = n - 1;
      while (i >= 0 && s.ts[i] > ts) i--;
      s.ts.splice(i + 1, 0, ts);
      s.px.splice(i + 1, 0, price);
    } else {
      s.ts.push(ts);
      s.px.push(price);
    }
  }

  /** Last price at or before ts; null if none is known. */
  at(contract: string, ts: number): number | null {
    const s = this.series.get(contract);
    if (!s || !s.ts.length || s.ts[0] > ts) return null;
    let lo = 0;
    let hi = s.ts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s.ts[mid] <= ts) lo = mid;
      else hi = mid - 1;
    }
    return s.px[lo];
  }

  trim(now: number): void {
    const cut = now - this.keepMs;
    for (const s of this.series.values()) {
      let i = 0;
      while (i < s.ts.length - 1 && s.ts[i + 1] < cut) i++;
      if (i > 0) {
        s.ts.splice(0, i);
        s.px.splice(0, i);
      }
    }
  }
}
