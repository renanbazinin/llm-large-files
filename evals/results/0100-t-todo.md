# Package T of 0.10.0: the live runs left

The Gemini project's monthly spending cap stopped package T's live calls on 2026-11-24 ("Your
project has exceeded its monthly spending cap"). These are the runs to make once it is lifted. Run
them from the root of a checkout of `feat/0100-t`, with `GEMINI_API_KEY` in the environment. None of
them has been run.

## 1. Record the 12 Gemini 3.8 Flash cassettes that fail replay

They were recorded before the declaration of `analyze_whole_document` changed (725f85a, 5e5da61), so
`npm run eval:replay` fails on each with "prompt changed: re-record" (`0100-t-record-2.md`). Record them one case at a time, as
Flash was recorded before:

```sh
npm run eval:record -- --models gemini-3.8-flash --concurrency 1 \
  --cases log-failover,log-deploy,log-disk,log-hebrew,contract-penalties,contract-largest-en,contract-summary,diary-timeline,cleaning-sanctions,diary-planted-nothing,chat-uploads,chat-log-orders \
  --results evals/results/0100-t-record-3.json \
  --title "Evals: package T of 0.10.0, the 12 Flash cassettes recorded again" \
  --max-input-tokens 3000000
npm run eval:replay
```

Every case should then replay. contract-summary must hold a whole read on both models
(`wholeReadOn` is not set). If Flash searched instead while recording it, the replay fails with "no
whole read". Record that case again on its own, with the same command and `--cases contract-summary`.

## 2. The live pass^3 of the whole-read cases, on both models

The whole-read gate is pass^3 with no fact lost against the 0.9.0 baseline. The last live runs
(`0100-t-live-2.md`, at 725f85a) did not meet it, and no live run has been made since 5e5da61, which
names "answer" for a timeline and sends a part with the heading it starts under:

```sh
npm run eval:live -- --k 3 --concurrency 2 \
  --models gemini-3.5-flash-lite,gemini-3.8-flash \
  --cases contract-summary,diary-timeline \
  --results evals/results/0100-t-live-3.json \
  --title "Evals: package T of 0.10.0, whole-file reads live (pass^3)" \
  --max-input-tokens 3000000
```

The report (`0100-t-live-3.md`) gives the gate for each model. To measure T's other two cases the
same way, add `diary-planted-nothing,cleaning-sanctions` to `--cases`, as in `0100-t-live.md`.

## 3. A fresh live items measure on both contracts

The items reads of contract-1 and cleaning-1 through the tool set and `gemini()`'s part reader:
three reads of each file by each model, with no chat model in between. The script is
`0100-t-items.live.ts.txt`, and it runs from a folder outside the repository:

```sh
REPO=$(pwd)
M=$(mktemp -d)
sed "s#<repository>#$REPO#g" evals/results/0100-t-items.live.ts.txt > "$M/measure.live.ts"
ln -s "$REPO/node_modules" "$M/node_modules"
printf 'export default { test: { environment: "node", include: ["%s/measure.live.ts"], testTimeout: 0, hookTimeout: 120000 } };\n' "$M" > "$M/measure.config.ts"
MEASURE_RUNS=3 MEASURE_SKIP_PLANTED=1 MEASURE_DIR="$M" MEASURE_OUT=items-5.json \
  npx vitest run --config "$M/measure.config.ts" --root "$M"
cp "$M/items-5.json" evals/results/0100-t-items-5.json
```

The script writes one line for each read as it goes: `replies` and `parsed` give the parse share,
and `total_items` against `expected` (37) says whether the total is exact. Add the results as round
5 of the items table in `0100-t-direct.md`. The gate on Gemini 3.5 Flash-Lite is at least 95% of
part replies parsed and every total exact. No live round has run since the near check (ce0a1f8) and
the heading a part starts under (5e5da61). Round 4's replies, checked again with the near check,
gave 37 in all 9 reads.
