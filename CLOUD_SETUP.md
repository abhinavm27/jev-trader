# Cloud dry run with OpenRouter

Deploy this modified checkout as one Railway service using the existing Dockerfile
and railway.json. Keep one replica and disable sleeping/serverless mode.
The cloud entry point forces DRY_RUN=true and removes PRIVATE_KEY before loading
the application. No wallet is required. Do not deploy the unmodified upstream
repository if you want the OpenRouter adapter.

Set these service variables before deployment:

```dotenv
MODEL=openrouter
OPENROUTER_MODEL_ID=~typesafe/jev-latest
DRY_RUN=true
RPC_URL=https://rpc.monad.xyz
READ_RPC_URL=https://rpc.monad.xyz
```

Set OPENROUTER_API_KEY privately in Railway to a replacement key. Never commit it.
Set a credit limit on that key before starting: this bot can call the API every
block, roughly 288,000 calls/day. No automatic retries are added by the adapter.
API requests time out after 2 seconds; this does not guarantee the 300ms budget.
First deploy MODEL=mock to check chain connectivity without API charges, then
switch to MODEL=openrouter for a short observed trial.

The service exposes JSON at /, recent events at /history, and SSE at /events.
The existing frontend is a separate project and is not deployed by this setup.
Avoid enabling a public domain unless you want these unauthenticated read-only
endpoints public. A successful HTTP health check means the server is running,
not that Jev or the market feed is healthy; inspect advancing blocks and decisions.

Limitations: the last 1000 events and paper positions are in memory and reset on
restart. This is an initial connectivity/latency trial, not a durable forward-test
recorder. The upstream cost estimate uses TypeSafe pricing, not verified OpenRouter
billing; use the provider's actual usage for costs. The upstream prediction prompt
describes crossing the spread although execution uses post-only limit orders;
it is preserved here to avoid silently changing strategy. Simulated fills omit
real queue priority. No live profitability has been established.

After deployment, confirm dryRun=true, model=~typesafe/jev-latest, advancing block
numbers, and non-late decisions. Check provider usage and latency before extending
the trial. Stop the service to end the trial.
