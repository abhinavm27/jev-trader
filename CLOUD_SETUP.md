# Paper research deployment

Cloud startup forces DRY_RUN=true and MODEL=mock, deletes wallet and model keys
from the process environment, and loads src/research.ts. There are NO paid model
calls or transaction sends in this mode. Setting MODEL=openrouter cannot enable
AI through this entry point. A future paid trial needs a separately implemented
budgeted mode; paid inference remains disabled until then.

Two independent spot strategies share each timestamped book and trade-print
batch: momentum/imbalance and inventory rebalancing. Each starts with $100,
50% USDC and 50% MON, and is compared with holding that same allocation. Results
are independent counterfactual portfolios, not simultaneous orders. Quote size
is 200 MON, evaluated every 5 seconds; identical outstanding quotes are retained.

Simulation: quotes cannot fill until after a conservative arrival block. Only
strict trade-through prints qualify, and fills are capped to 10% of observed
print volume. This is a sensitivity assumption, NOT validated queue simulation.
Both strategies use exactly the same fill rule. No borrowing or naked shorts.

Metrics: gross realized/unrealized P&L, hypothetical gas and exchange fees,
net before hosting, buy-and-hold P&L, excess vs hold, inventory, turnover, fills,
orders, marked-to-mid drawdown, read latency, errors, data gaps and stale feeds.
Gas defaults to 0.0357 MON/order (350000 gas * 102 gwei), an illustrative
scenario rather than live measured transaction cost. PAPER_FEE_BPS defaults to
0 and is explicitly UNVERIFIED. HOSTING_USD_PER_HOUR is unknown unless supplied;
all-in P&L is null until supplied and remains an estimate thereafter. Fee rebates,
queue position, transaction reverts and liquidation costs are not modeled.

Environment settings:
- QUOTE_INTERVAL_MS=5000 (minimum 1000)
- PAPER_GAS_MON=0.0357
- PAPER_FEE_BPS=0 (verify Kuru maker fees/rebates before judging profitability)
- PAPER_PARTICIPATION=0.1
- HOSTING_USD_PER_HOUR: optional known cost allocation
- METRICS_TOKEN: optional bearer token if exposing endpoints publicly

Storage: SQLite WAL transactions save observations and each run's latest summary.
New processes start new run IDs and new balances; they do NOT silently stitch
portfolios together. /runs retains old summaries only if the database survives.
Observation retention is the newest 100000 samples globally (~28h at 1Hz).
Old raw observations are pruned, summaries retained. Export before retention.

REQUIRED for durability on Railway: attach a volume to jev-trader-runner mounted
at /data. The app uses RAILWAY_VOLUME_MOUNT_PATH automatically. Without it,
storage is ephemeral and redeploys may lose the SQLite file. The startup log and
/summary disclose persistentVolume=false. DATA_DIR alone is not a volume.
Railway runtime logs also receive summaries every 60 samples; provider log
retention applies and is not a replacement for durable raw data.

Endpoints (private networking by default):
- /health: requires a successful market sample in the last 15 seconds
- /summary: assumptions, run ID and latest metrics
- /runs: up to 100 run summaries, newest first
- /export?after=0: JSON pages of 1000 observations; use nextCursor for next page

No public domain is created. A dashboard is not included. Inspect Railway logs
for RESEARCH_START and RESEARCH_SUMMARY. Initial run is an engineering check;
profitability needs longer matched windows, validated costs, and sensitivity
analysis. Old Jev run is not a valid same-period comparison with these baselines.


## Bounded parallel paper trial
Start `bun run src/parallel.ts` with `DRY_RUN=true`, `OPENROUTER_MODEL_ID=typesafe/jev-1.13`, the existing key, and a persistent volume. Two $100 paper accounts (Jev and momentum) receive the same sampled book and prints. Both quotes use a conservative arrival after inference so neither gets fills from already observed trades. This compares decisions under shared timing, not the latency advantage of a free strategy. Market sampling is about 1Hz, so subsecond returns are approximate.

The persisted trial lasts at most 28 hours, with requests no faster than every five seconds and a $3.50 input-inference budget at $0.042/M tokens. A full 32,000-token reservation is stored BEFORE each request. Valid returned input usage releases the unused amount; absent usage, failed calls, and interrupted calls retain the entire reservation. No automatic retries. Five consecutive failures pause the AI. The model version is pinned for pricing stability. Hosting and credit-purchase fees are outside this cap.

`PARALLEL_SUMMARY` logs roll up P&L, gas/fee scenarios, cost allowance, fills, turnover, drawdown, holdings and AI-minus-baseline performance every 60 observations. `AI_USAGE` records each call's usage without secrets or prompt text. These can be read through the Railway plugin on demand. `/summary`, `/runs`, and `/export` provide the same private metrics/history. No public domain is necessary.

To stop only the AI, set `AI_PAUSED=true` on the runner and redeploy the current commit. Saved accounts, spend and deadline survive; baseline continues after the brief restart. Pause is sticky in SQLite. If a METRICS_TOKEN has been securely provisioned, authenticated `POST /ai/pause` pauses without a restart. No resume endpoint is exposed. Stop cancels the hypothetical outstanding AI order, leaves holdings marked to market, and stores an AI_STOP_SUMMARY for a matched comparison at stop time. Later comparisons are not active-AI comparisons. Existing free-only research summaries are retained.

This remains paper trading. Gas and exchange fees are scenario estimates, hosting is unmeasured, and no claim of live profitability should be inferred.
