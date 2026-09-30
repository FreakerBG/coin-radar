# Manual Axiom shortlist: filter research (2026-09-30)

This is a research plan, not a profitable strategy or a production rule change. The hourly ramp reached 349 distinct pairs in a rolling day; 15-minute detection failed the agreed 300-pair capacity gate. A detector that samples only the latest DEX Screener profiles and paid boosts, up to 30 tokens per run, cannot claim to cover all Axiom Pulse new launches.

## Provider mapping

| Question | Coin Radar today | Axiom Pulse | Action |
| --- | --- | --- | --- |
| Developer supply | RugCheck `creatorBalance / token.supply` (creator holding), with a ≤10% verified-safety bar | `Dev Holding %` | Show the two labels separately. Do not equate a creator balance with every developer-linked wallet. Test Axiom's definition and source before matching thresholds. |
| Concentration | RugCheck largest holder ≤20% and reported top holders ≤50%, merged by owner | `Top 10 Holders %` | The reported holder set may differ from exactly ten. Preserve the actual denominator, owner aggregation, and timestamp. |
| Insider/sniper/bundle | RugCheck insider-network count must be zero; no sniper or bundle percentage | `Insiders %`, `Snipers %`, `Bundle %` | Treat missing measures as unavailable. Do not infer them from buy/sell counts or quietly assign zero. |
| Pool liquidity and exit depth | DEX Screener liquidity ≥$25k hard gate; valuation/liquidity ≤100 risk check; RugCheck LP locked ≥80% | `Liquidity ($)` | Compare live exact pool and a proposed trade size; reported liquidity is not executable depth. |
| Valuation | DEX Screener market cap and FDV are stored; dilution affects score; no minimum cap hard gate | `Market Cap ($)` | Test cap bands. Missing market cap with FDV present is not interchangeable for a cap filter. |
| Age, volume, flow | Pool age ≥15 min, transaction counts, volume acceleration, buyer pressure, overheating/collapse gates | Age, Volume, Txns, Num Buys, Num Sells | Compare the same time window, and don't treat transaction count as unique buyers. |
| Contract permissions | RugCheck mint/freeze authority, LP lock, holders, creator and insider facts; missing evidence fails closed | Axiom risk indicators may have different definitions | Keep explicit permission and safety checks. Token extensions can add authority types beyond mint/freeze. |

The current verified-safety thresholds above describe **code defaults**, not evidence-backed optimums. Axiom documents these Pulse filter names but does not publish winning settings. Its Explore view also has cap, liquidity, volume, transactions, and top-holder filters. Sources: [Axiom Pulse](https://docs.axiom.trade/axiom/finding-tokens/pulse.md), [Axiom Explore](https://docs.axiom.trade/axiom/finding-tokens/explore-tokens.md), [Solana authority roles](https://solana.com/docs/tokens/basics/set-authority), [DEX Screener API](https://docs.dexscreener.com/api/reference).

## Candidate tests, not live thresholds

1. **Safety first:** compare verified and failed/unavailable contract evidence without ever presenting failed/unavailable as trade-ready. Track creator holding in exploratory bands `0–2`, `>2–5`, `>5–10`, `>10%`; top-holder and top-ten concentrations as separate continuous variables. Where Axiom's developer, insider, sniper or bundle metrics have no historical timestamped source, leave them out of historical claims and inspect them manually at handoff.
2. **Entry maturity:** compare pool age `15–60 min`, `1–6 h`, `6–24 h`, `>24 h` within the sampled discovery source. An hourly sample cannot validate a five-minute launch strategy. A recent Solana rug-pull study finds many failures in the first hour; this motivates separate age groups, not a guaranteed safe age. [Li et al., 2026](https://arxiv.org/abs/2608.20271).
3. **Valuation and depth:** compare market-cap bands `<$100k`, `$100–500k`, `$500k–2m`, `>$2m`, each stratified by liquidity `$25–50k`, `$50–100k`, `>$100k`. These are exploratory bins; test alternate boundaries later on untouched data. Include FDV/market-cap ratio and valuation/liquidity. A low market cap by itself is not an edge.
4. **Momentum quality:** compare early/building/breakout states, volume acceleration, sell activity, turnover versus liquidity, and positive flow across the same observation window. Flag paid promotion and one-sided buys; reported volume can be manipulated. A cross-chain study observed artificial-growth indicators even among high-return meme coins. [Mongardini and Mei, 2026](https://arxiv.org/abs/2507.01963).
5. **Execution:** replay a *manual* entry rule at the first time the complete evidence was available, never at an earlier candle. Compare realistic fill/exit estimates including Axiom and chain fees, slippage and price impact. Existing 1-, 3-, and 7-day DEX Screener snapshots are descriptive and cannot validate a minutes-to-hours Axiom trade. Keep paper trades until entry and exit observations exist.

## Evaluation contract

- Read the signed-in backtest's `filterFunnel`, `coverage`, `truncated`, `denominators`, and per-horizon outcome coverage first. Its detailed sample caps at 2,000 recent signals across model versions. At high scan volume it may not contain a full month. Do not select thresholds from only observed winners or silently discard pending/missed/unavailable outcomes.
- Use chronological development and later holdout periods, and deduplicate or group repeated mint/pool observations so the same coin is not counted as independent trades. Compare against the current fixed model and simple baselines. Report candidate count, safety coverage, drawdowns, and outcomes after estimated execution costs.
- Keep safety checks hard and missing data explicit. Version any eventual model change. Axiom/Phantom links remain manual; no automatic position or order is created.
