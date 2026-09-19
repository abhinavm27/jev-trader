# Queue-inspired paper experiment

Start: `DRY_RUN=true bun run src/queue-runner.ts`. Requires the existing research SQLite database and enriched checkpoint. Never submits wallet transactions or calls an AI endpoint. The replacement freezes earlier arms, keeps their records and the original deadline, and starts two matched $100 virtual accounts (50% cash, 50% MON).

## Hypothesis and mechanics

Treat best bid and ask depth as two queues. Additions grow them; executions and cancellations shrink them. Simulate which empties first within 30 seconds. Separately estimate whether an order behind displayed depth can fill in that time. Favor buying when ask depletion dominates, selling when bid depletion dominates, but reject long queues and weak forecasts.

At unchanged touch prices, infer net additions/removals from successive depths after accounting for observed trades. Exponentially smooth with a 20-second time constant. Median observed trade size supplies a simulation volume unit. Run 128 seeded birth/death paths, stopping at first depletion, 30 seconds, or 1024 events. The rates are constant over each path, not fitted state-dependent intensities. Warm up for 60 contiguous seconds; missing/stale data resets warmup. Changed-touch intervals cannot identify these flows and are omitted from depth-rate estimation. This selection can bias estimates.

The signal requires directional depletion probability at least 0.60 and fluid queue-wait estimate `(displayed volume + order size) / opposite trade-volume rate` at most 30 seconds. These thresholds are hypotheses, not optimized or calibrated. The blind benchmark chooses the inventory-balancing side without these two filters. Both use the same mark-to-mid score: half-spread capture plus directional first-move forecast (zero for blind), minus three assumed gas actions, two fees, and a 2bp buffer. A positive score is NOT evidence of positive round-trip or fill-conditional expected profit. Exit execution and adverse selection remain unresolved.

## Fill simulation and limits

Join at touch, 200 MON, with block-based arrival delay. On the first post-arrival snapshot join behind all visible depth at the limit. No fills from that same block. Only subsequent opposite-side trade volume reduces queue-ahead; cancellations never improve priority. Fill volume is capped at 10% of each print and remaining order size. Reject quotes crossing at arrival. Pending cancellations have a block delay and a cost. Orders expire after 30 seconds; projected inventory stays within 20–80% for new quotes. Data gaps and restarts discard virtual orders and charge cancellation once where possible.

This is NOT exact FIFO reconstruction: venue priority is not verified, snapshots hide within-second activity, and hidden liquidity, amendments and market impact are unmodeled. Missing depth causes conservative abandonment. Gas of 0.0357 MON/action and zero exchange fee are unverified scenarios; hosting is excluded. Earlier strategy fills are NOT directly comparable to this stricter simulator. Both new arms share it.

## Evaluation and next experiments

SQLite queue_events records decisions, rates, predictions, submitted orders, fills and 5/15/30/60-second markouts. Forecast records also receive 30-second returns: these returns are NOT labels for first-depletion probabilities. Reports include equity, excess over passive hold, costs, drawdown, fills, cancellation/rejection counts and invalid delayed labels. `/summary`, `/runs`, `/decisions`, `/outcomes`, `/export` are private service endpoints; summary logs support inspection without public exposure. AI inference cost is zero for both new arms.

Judge matched-period excess over hold and net PnL, not direction accuracy alone. Analyze markouts conditional on actual simulated fills and queue-wait bands. Overlapping observations are correlated: use time-block uncertainty estimates, walk-forward holdouts and multiple day/regime coverage before claiming an edge. No automated threshold learning or live trading is enabled.

Next priorities: verify venue priority, capture event-level order updates, label actual first depletion separately, estimate state-dependent intensities in queue-size bins, calibrate held-out probabilities and fill-time distributions, then test Hawkes/self-exciting trade flow and 1/5/15-minute volatility/trend conditioning as separate ablations. A slower research agent can propose changes offline; it should not rewrite strategy rules mid-evaluation.

Research: Huang, Lehalle & Rosenbaum, [queue-reactive model](https://arxiv.org/abs/1312.0563); Gould & Bonart, [queue imbalance and next price movement](https://arxiv.org/abs/1512.03492). These motivate experiments, not a transferable profit guarantee.
