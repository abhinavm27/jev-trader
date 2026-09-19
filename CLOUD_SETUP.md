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
