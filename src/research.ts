import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Market } from './market';
import { config } from './config';
import { log10 } from './book';
import { TradeFeed } from './trades';
import { PaperAccount } from './paper';

// This entry point has no AI model imports or API calls and cannot send transactions.
if (!config.dryRun || config.model !== 'mock') throw new Error('Research mode requires DRY_RUN=true and MODEL=mock; paid inference is disabled');
function numberEnv(name: string, fallback: number, min: number, max: number) {
  const x = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(x) || x < min || x > max) throw new Error(`Invalid ${name}`);
  return x;
}
const intervalMs = numberEnv('QUOTE_INTERVAL_MS', 5000, 1000, 3600000);
const feeBps = numberEnv('PAPER_FEE_BPS', 0, 0, 1000);
const gasMon = numberEnv('PAPER_GAS_MON', 0.0357, 0, 10);
const participation = numberEnv('PAPER_PARTICIPATION', 0.1, 0.001, 1);
const hostingHourly = process.env.HOSTING_USD_PER_HOUR === undefined ? null : numberEnv('HOSTING_USD_PER_HOUR', 0, 0, 100);
const persistent = Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH);
const dir = process.env.RAILWAY_VOLUME_MOUNT_PATH ?? process.env.DATA_DIR ?? 'data';
mkdirSync(dir, { recursive: true });
const db = new Database(join(dir, 'research.sqlite'), { create: true });
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, started INTEGER, config TEXT, summary TEXT); CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY, run TEXT, ts INTEGER, payload TEXT); CREATE INDEX IF NOT EXISTS obs_run ON observations(run, id);');
const id = crypto.randomUUID(), started = Date.now();
const assumptions = { version: 1, initialUsd: 100, allocation: '50% USDC / 50% MON', intervalMs, feeBps, gasMon, participation,
  fillRule: 'strict trade-through after conservative arrival block; partial fills capped at participation of each print',
  gasSource: 'scenario: 350000 gas * 102 gwei; not a live gas measurement',
  feesVerified: false, hostingHourly, paidInferenceEnabled: false, persistentVolume: persistent,
  retention: 'latest 100000 observations globally (~28 hours at 1Hz); run summaries retained',
  limitations: ['No queue-position reconstruction', 'No transaction revert simulation', 'Fee scenario needs exchange verification', 'Independent strategy counterfactuals, not simultaneous orders', 'New account balances each run; compare within run only'] };
db.query('INSERT INTO runs VALUES (?, ?, ?, NULL)').run(id, started, JSON.stringify(assumptions));
const insert = db.query('INSERT INTO observations(run,ts,payload) VALUES (?,?,?)');
let latest: any = null, busy = false, samples = 0, errors = 0, gaps = 0, staleFeed = 0, lastAt = 0, lastBlock = 0, lastQuote = 0;
let peakReadMs = 0, sumReadMs = 0, slowReads = 0;
let accounts: Record<string, PaperAccount> = {};
const market = new Market();
await market.init();
const feed = new TradeFeed({ market: config.market, url: config.readRpcUrl, sizeDec: log10(market.params.sizePrecision) });
let mids: { ts: number; mid: number }[] = [];
const tick = Number(market.params.tickSize.toString()) / Number(market.params.pricePrecision.toString());
const token = process.env.METRICS_TOKEN;
Bun.serve({ port: config.port, fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === '/health') return Response.json({ ok: Boolean(latest && Date.now() - latest.ts < 15000), paidInferenceEnabled: false }, { status: latest && Date.now() - latest.ts < 15000 ? 200 : 503 });
  if (token && req.headers.get('authorization') !== `Bearer ${token}`) return new Response('Unauthorized', { status: 401 });
  if (u.pathname === '/' || u.pathname === '/summary') return Response.json({ runId: id, started, assumptions, latest });
  if (u.pathname === '/runs') return Response.json(db.query('SELECT * FROM runs ORDER BY started DESC LIMIT 100').all());
  if (u.pathname === '/export') {
    const after = Number(u.searchParams.get('after') ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) return new Response('Invalid cursor', { status: 400 });
    const rows = db.query('SELECT id, run, ts, payload FROM observations WHERE id > ? ORDER BY id LIMIT 1000').all(after) as any[];
    return Response.json({ nextCursor: rows.at(-1)?.id ?? after, rows: rows.map(r => ({ ...r, payload: JSON.parse(r.payload) })) });
  }
  return new Response('Not found', { status: 404 });
} });
console.log('RESEARCH_START ' + JSON.stringify({ runId: id, started, assumptions }));
async function sample() {
  if (busy) { gaps++; return; }
  busy = true;
  try {
    const t = performance.now();
    const book = await market.readBook();
    const readMs = performance.now() - t;
    if (![book.mid, book.bid, book.ask].every(x => Number.isFinite(x) && x > 0) || book.ask < book.bid) throw new Error('Invalid market book');
    const block = book.block;
    if (!Number.isSafeInteger(block) || block <= 0) throw new Error('Invalid book block');
    if (block <= lastBlock) { staleFeed++; return; }
    lastBlock = block;
    await feed.poll(block);
    if (feed.lastBlock < block) { staleFeed++; return; }
    const now = Date.now();
    if (lastAt && now - lastAt > 3000) gaps++;
    lastAt = now;
    const prints = feed.drainPrints();
    if (!Object.keys(accounts).length) accounts = { momentum: new PaperAccount(100, book.mid, {gasMon, feeBps, participation}), inventory: new PaperAccount(100, book.mid, {gasMon, feeBps, participation}) };
    for (const account of Object.values(accounts)) for (const p of prints) account.consume(p);
    mids.push({ts:now, mid:book.mid}); mids = mids.filter(m => now - m.ts <= 35000);
    const reference = mids.find(m => now - m.ts <= 30000)!;
    const returnBps = (book.mid / reference.mid - 1) * 10000;
    const signals = { momentum: returnBps / 8 + book.imbalance * 1.5 };
    const quotes: any[] = [];
    if (now - lastQuote >= intervalMs) {
      lastQuote = now;
      for (const [name, a] of Object.entries(accounts)) {
        const side = name === 'momentum' ? (signals.momentum >= 0 ? 'buy' : 'sell') : (a.mon * book.mid > a.cash ? 'sell' : 'buy');
        const price = side === 'buy' ? Math.min(book.bid + tick, book.ask - tick) : Math.max(book.ask - tick, book.bid + tick);
        // Extra block after observation + elapsed read/feed time; never fill from already observed prints.
        const arrival = block + Math.ceil((performance.now() - t) / 300) + 1;
        if (a.quote(side, price, 200, arrival, book.mid)) quotes.push({strategy:name, side, price, arrival});
      }
    }
    samples++; sumReadMs += readMs; peakReadMs = Math.max(peakReadMs, readMs); if (readMs > 300) slowReads++;
    const hosting = hostingHourly === null ? null : (now - started) / 3600000 * hostingHourly;
    latest = { ts: now, block, mid: book.mid, samples, errors, gaps, staleFeed, readLatencyMs: { mean:sumReadMs/samples, max:peakReadMs, above300:slowReads },
      strategies: Object.fromEntries(Object.entries(accounts).map(([name,a]) => {const m=a.metrics(book.mid); return [name, {...m, aiCostUsd:0, estimatedHostingUsd:hosting, estimatedAllInUsd:hosting===null?null:m.netBeforeHostingUsd-hosting}]})) };
    db.transaction(() => {
      insert.run(id, now, JSON.stringify({ book, prints, signals, quotes, metrics:latest }));
      db.query('UPDATE runs SET summary=? WHERE id=?').run(JSON.stringify(latest), id);
      if (samples % 60 === 0) db.exec('DELETE FROM observations WHERE id <= (SELECT MAX(id)-100000 FROM observations)');
    })();
    if (samples === 1 || samples % 60 === 0) console.log('RESEARCH_SUMMARY ' + JSON.stringify({runId:id, ...latest}));
  } catch (e) { errors++; console.error('RESEARCH_ERROR ' + (e as Error).message); }
  finally { busy = false; }
}
setInterval(sample, 1000);
await sample();
