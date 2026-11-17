[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/tunnelmoon/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/tunnelmoon/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01)

# The Launch Radar

A token launch radar for [make.fun bounty token-radar-01](https://make.fun/bounty/token-radar-01): it reads a sealed DefiLlama snapshot of 758 protocols, fits an implied-value model on the snapshot's own traded tokens, ranks the 40 watchlist protocols plus 156 pre-token protocols below the floor, and hands in a dashboard with a farm plan for every row.

## The model

One log-log comps regression, fitted at run time on the snapshot's traded tokens:

```
log10(implied) = b0 + b1 x log10(TVL) + b2 x growth + b3 x log10(age + 30) + group effect
```

The comps set is the traded protocols the market prices on TVL: exchanges, bridges, staking products, versioned pools, zero market caps, and ratios outside 0.005 to 5 are set aside. The fit is tested out of sample by leave-one-out cross-validation, and the dashboard reports the result plainly (median error, mean error, share within a factor of two). No protocol name is special-cased, and every farm plan is derived from the protocol's own record (category, chains, TVL, age).

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json
```

`main.ts` (Node 22, standard library only) writes `board.json`, `data.js`, `dashboard/` and `screenshots/` to the output directory, then `dossier.json` with the vendored make.fun library. Run it twice and the outputs are byte-identical.

## Files

- `main.ts` - the entrypoint: reads the snapshot, fits the model, writes the board and the dossier
- `lib/model.ts` - the comps fit, the board, the farm plans, the snapshot parser
- `vendor/makefun-board.ts` - the kit's dossier library, unchanged
- `dashboard/` - the static page (index.html, app.css, app.js), no network
- `screenshots/` - the board, a protocol detail view, a filtered view
