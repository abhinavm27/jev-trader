/** Durable budget state. Reserve a full 32K context before every request.
 * Unknown/failed billing keeps the reservation; never assume failures are free. */
export class Trial {
  started = Date.now();
  deadline = this.started + 28 * 3600000;
  capUsd = 3.5;
  chargedUsd = 0;
  knownCostUsd = 0;
  unresolved = 0;
  calls = 0;
  successes = 0;
  failures = 0;
  consecutiveFailures = 0;
  tokens = 0;
  latencyMs = 0;
  paused = false;
  reason: string | null = null;
  readonly reserveUsd = 32000 * 0.042 / 1e6;
  status(now = Date.now()) {
    return this.paused ? 'paused' : now >= this.deadline ? 'time_limit' : this.chargedUsd + this.reserveUsd > this.capUsd ? 'budget_limit' : 'running';
  }
  reserve(now = Date.now()) {
    if (this.status(now) !== 'running') return false;
    this.chargedUsd += this.reserveUsd; this.unresolved++; this.calls++; return true;
  }
  settle(tokens: number, latency: number) {
    this.successes++; this.consecutiveFailures = 0; this.latencyMs += latency;
    if (Number.isSafeInteger(tokens) && tokens > 0 && tokens <= 32000) {
      const cost = tokens * 0.042 / 1e6;
      this.chargedUsd += cost - this.reserveUsd; this.knownCostUsd += cost;
      this.unresolved--; this.tokens += tokens;
    }
  }
  fail() {
    this.failures++; this.consecutiveFailures++;
    if (this.consecutiveFailures >= 5) { this.paused = true; this.reason = 'five_consecutive_errors'; }
  }
}
