// The token radar's model: one sealed snapshot in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds the
// pre-token protocols below the floor with the most TVL, the early rows the radar exists to find.
// A protocol is pre-token when its record carries no token: no market cap, no CoinGecko id, no
// symbol. Live-token protocols are kept apart and shown with the market's own values.
//
// Implied value is fitted, not assumed. The model is a log-log comps regression on the snapshot's
// own traded tokens: log10(market cap) as a function of log10(TVL), seven-day TVL growth, log10
// age in days, and a broad category group. The comps set drops the protocols the market does not
// price on TVL (exchanges, bridges, staking products, versioned pools, zero market caps, and the
// eight whose market-cap-to-TVL ratio sits outside 0.005 to 5). The fit is validated out of sample
// by leave-one-out cross-validation, and the dashboard reports the result plainly: TVL explains
// only part of token value, so the board ranks by the fitted model and shows every row's inputs.
//
// No protocol name is ever special-cased: the same fitted function scores every row, and the farm
// plan of every row is derived from the same record (category, chains, TVL, age).

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-comps-1';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 156;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories the market does not price on TVL, so they never enter the comps set. */
const COMPS_EXCLUDED_CATEGORIES = new Set([
  'CEX',
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
]);

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The broad group a category falls in, for the regression's category effects. */
export function groupOf(category: string | null): string {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral') || c.includes('basis trad')) return 'Lending';
  if (c.includes('dex')) return 'Dexs';
  if (c.includes('yield') || c.includes('farm') || c.includes('leveraged farm') || c.includes('liquidity manager')) return 'Yield';
  if (c.includes('rwa') || c.includes('stablecoin') || c.includes('dual-token')) return 'RWA/Stable';
  if (c.includes('stak') || c.includes('restak')) return 'Staking';
  if (c.includes('derivat') || c.includes('perpetual') || c.includes('options')) return 'Derivatives';
  return 'Other';
}

/** The groups, in the order their effects are fitted (the first is the baseline). */
export const GROUPS = ['Other', 'Yield', 'Lending', 'Dexs', 'Staking', 'RWA/Stable', 'Derivatives'];

/** The growth the model uses, in per cent, clamped so one wild week cannot move a value. */
export function clampedGrowth(p: SnapshotProtocol): number {
  return Math.min(60, Math.max(-60, finite(p.change_7d, 0)));
}

/** The age the model uses, in days; an unlisted protocol is treated as a year old. */
export function ageForModel(asOf: string, p: SnapshotProtocol): number {
  return ageDays(asOf, p.listed_at) ?? 365;
}

/** One row of the regression's design matrix: intercept, log TVL, growth, log age, group dummies. */
export function designRow(asOf: string, p: SnapshotProtocol): number[] {
  const row: number[] = [
    1,
    Math.log10(Math.max(1, p.tvl_usd)),
    clampedGrowth(p) / 100,
    Math.log10(ageForModel(asOf, p) + 30),
  ];
  for (let i = 1; i < GROUPS.length; i++) row.push(groupOf(p.category) === GROUPS[i] ? 1 : 0);
  return row;
}

/** Solve A x = b by Gauss-Jordan elimination with partial pivoting. */
export function solveLinear(a: number[][], b: number[]): number[] {
  const n = a.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r;
    [m[c], m[piv]] = [m[piv]!, m[c]!];
    const d = m[c]![c]!;
    if (Math.abs(d) < 1e-12) throw new SnapshotError('comps regression is singular');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / d;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / m[i]![i]!);
}

/** Invert a square matrix by Gauss-Jordan elimination with partial pivoting. */
export function invertMatrix(a: number[][]): number[][] {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (j === i ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r;
    [m[c], m[piv]] = [m[piv]!, m[c]!];
    const d = m[c]![c]!;
    if (Math.abs(d) < 1e-12) throw new SnapshotError('comps regression is singular');
    for (let k = 0; k < 2 * n; k++) m[c]![k]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]!;
      for (let k = 0; k < 2 * n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row) => row.slice(n));
}

/** The fitted comps model: coefficients, the comps it was fitted on, and its out-of-sample test. */
export interface FittedModel {
  coefficients: number[];
  comps: number;
  excluded: number;
  r2: number;
  looMedianApe: number;
  looMeanApe: number;
  looWithin2x: number;
  groupMedianRatio: { group: string; n: number; medianRatio: number }[];
  overallMedianRatio: number;
}

/** The median of numbers, or null when there are none. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * The comps set: traded protocols the market prices on TVL. A traded protocol is dropped when its
 * category is an exchange, bridge or staking product, its name ends in a version marker, its market
 * cap is zero, or its market-cap-to-TVL ratio sits outside 0.005 to 5: those are priced on
 * something else, and a comps set that kept them would fit their noise instead of the market.
 */
export function compsSet(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter((p) => {
    if (p.mcap_usd === null || p.mcap_usd <= 0) return false;
    if (COMPS_EXCLUDED_CATEGORIES.has(p.category ?? '')) return false;
    if (VERSIONED.test(p.name)) return false;
    const ratio = p.mcap_usd / p.tvl_usd;
    return ratio >= 0.005 && ratio <= 5;
  });
}

/**
 * Fit the comps model by ordinary least squares on log10(market cap), and test it out of sample by
 * leave-one-out cross-validation, using the hat matrix so each protocol is predicted without itself.
 * The test reports the median absolute percentage error, the mean, and the share predicted within
 * a factor of two: the honest numbers, not the flattering ones.
 */
export function fitModel(snapshot: Snapshot): FittedModel {
  const comps = compsSet(snapshot);
  const traded = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0);
  if (comps.length < 20) throw new SnapshotError(`only ${comps.length} comps: too few to fit`);
  const x = comps.map((p) => designRow(snapshot.as_of, p));
  const y = comps.map((p) => Math.log10(p.mcap_usd!));
  const k = x[0]!.length;
  const xtx: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < x.length; i++) {
    for (let a = 0; a < k; a++) {
      xty[a]! += x[i]![a]! * y[i]!;
      for (let b = 0; b < k; b++) xtx[a]![b]! += x[i]![a]! * x[i]![b]!;
    }
  }
  const beta = solveLinear(xtx, xty);
  const xtxInv = invertMatrix(xtx);
  const yMean = y.reduce((a, b) => a + b, 0) / y.length;
  let ssTot = 0;
  let ssRes = 0;
  const apes: number[] = [];
  let within2x = 0;
  for (let i = 0; i < y.length; i++) {
    const row = x[i]!;
    const pred = row.reduce((a, v, j) => a + v * beta[j]!, 0);
    ssTot += (y[i]! - yMean) ** 2;
    ssRes += (y[i]! - pred) ** 2;
    // The hat value h_ii: how much this protocol pulls its own fitted value.
    let h = 0;
    for (let a = 0; a < k; a++) {
      let s = 0;
      for (let b = 0; b < k; b++) s += row[b]! * xtxInv[a]![b]!;
      h += row[a]! * s;
    }
    const looLog = y[i]! - (y[i]! - pred) / (1 - h);
    const looValue = Math.pow(10, looLog);
    const actual = comps[i]!.mcap_usd!;
    apes.push(Math.abs(looValue - actual) / actual);
    if (looValue / actual >= 0.5 && looValue / actual <= 2) within2x++;
  }
  apes.sort((a, b) => a - b);
  const groupMedianRatio = GROUPS.map((g) => {
    const ratios = comps.filter((p) => groupOf(p.category) === g).map((p) => p.mcap_usd! / p.tvl_usd);
    return { group: g, n: ratios.length, medianRatio: median(ratios) ?? 0 };
  });
  return {
    coefficients: beta,
    comps: comps.length,
    excluded: traded.length - comps.length,
    r2: 1 - ssRes / ssTot,
    looMedianApe: median(apes) ?? 0,
    looMeanApe: apes.reduce((a, b) => a + b, 0) / apes.length,
    looWithin2x: within2x / comps.length,
    groupMedianRatio,
    overallMedianRatio: median(comps.map((p) => p.mcap_usd! / p.tvl_usd)) ?? 0,
  };
}

/** The fitted implied value of one protocol, in whole dollars, at least $1. */
export function impliedValue(asOf: string, p: SnapshotProtocol, model: FittedModel): number {
  const row = designRow(asOf, p);
  const logValue = row.reduce((a, v, j) => a + v * model.coefficients[j]!, 0);
  return Math.max(1, Math.round(Math.pow(10, logValue)));
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    log_tvl: number;
    growth_pct: number;
    log_age: number;
    group: string;
    group_effect: number;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with the farm plan generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  group: string;
  w?: 1;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  median_watchlist_tvl: number;
  model: FittedModel;
  rows: RadarRow[];
  live: LiveRow[];
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: FittedModel): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot,
  // but the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: pre-token protocols below the watchlist floor, by TVL, capped. Never a
  // replacement for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({
    p,
    implied: impliedValue(snapshot.as_of, p, model),
    age: ageDays(snapshot.as_of, p.listed_at),
  }));
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => {
    const group = groupOf(s.p.category);
    const groupIndex = GROUPS.indexOf(group);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token',
      age_days: s.age,
      implied_value_usd: s.implied,
      model: {
        log_tvl: Math.round(Math.log10(Math.max(1, s.p.tvl_usd)) * 1e4) / 1e4,
        growth_pct: clampedGrowth(s.p),
        log_age: Math.round(Math.log10(ageForModel(snapshot.as_of, s.p) + 30) * 1e4) / 1e4,
        group,
        group_effect: groupIndex <= 0 ? 0 : Math.round(model.coefficients[3 + groupIndex]! * 1e4) / 1e4,
      },
      farm_steps: farmSteps(s.p, s.age).map(stepText),
    };
  });
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Lend $${capital} of USDC on ${name} on ${chain} and leave the supply open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Add $${capital} of liquidity to the main pool of ${name} on ${chain} and leave the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} with ${name}, then put the bridged funds to work in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and hold the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Post $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund an account with $${capital} on ${name} and take one market position.`;
  if (c.includes('curator') || c.includes('allocator')) return `Put $${capital} into a ${name} vault on ${chain} and hold the vault shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the yield-bearing asset ${name} issues on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('risk')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares until the vault's term ends.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and leave the position open.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time, the last netting the
 * whole plan to the dollar. The plan is derived from the protocol's own record (category, chains,
 * TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const setupGas = capital >= 150 ? 8 : 4;
  const weeks = Math.max(1, Math.ceil(hold / 7));
  const weeklyGas = 2;
  const totalGas = setupGas + weeklyGas * weeks;
  const action = actionFor(p, capital, chain);
  return [
    {
      text: `Open a fresh wallet that holds only the funds you plan to farm, and write its seed phrase on paper, never in a file.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${setupGas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Do one qualifying action each week, a deposit, a borrow, a swap or a vote, so the wallet looks active in every snapshot.`,
      cost: `about $${weeklyGas} of gas a week, $${weeklyGas * weeks} over ${weeks} weeks`,
      time: '10 minutes a week',
    },
    {
      text: `Keep the position open for at least ${hold} days, so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays locked in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page from its own site and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction hash in a farm log, so you can repeat the position or unwind it in one sitting.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
    {
      text: `Total for this plan: $${capital} of capital locked for ${hold} days plus about $${totalGas} of gas, $${setupGas} to set up and $${weeklyGas * weeks} across ${weeks} weeks of activity.`,
      cost: `about $${totalGas} out of pocket if the position earns nothing; the $${capital} comes back when you unwind, minus slippage`,
      time: `${hold} days from first deposit to unwind`,
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow, onWatchlist: boolean): RadarRow {
  const out: RadarRow = {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    group: row.model.group,
  };
  if (onWatchlist) out.w = 1;
  return out;
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const model = fitModel(snapshot);
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const watchlistTvls = board
    .filter((r) => snapshot.watchlist.includes(r.slug))
    .map((r) => r.tvl_usd)
    .sort((a, b) => a - b);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source.replace(/https?:\/\/[^\s,]+/g, 'api.llama.fi'),
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    median_watchlist_tvl: watchlistTvls[Math.floor(watchlistTvls.length / 2)] ?? 0,
    model,
    rows: board.map((r) => radarRow(r, snapshot.watchlist.includes(r.slug))),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
