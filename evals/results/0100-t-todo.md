# Package T of 0.10.0: what ran, and what is left

The live stage's proposals, which the integrator accepted, are in c1fbbb5, and were measured live
on 2026-11-24. The runs of the earlier list (the 12 Flash cassettes, the pass^3 of
`0100-t-live-3.md`, round 5 of the items reads) all ran before that, at 6e4060a and 8758aac.

## What ran

1. **The code (c1fbbb5).** A `read_document` result cut short of its range by the size limit says,
   in `whole_file`, how many lines fit and that `analyze_whole_document` reads all of them, when
   the tool set declares that read, has a part reader and can read the file whole, and the result
   stays within its cap (no declaration or system text changes; `docs/reference/tools.md`). The
   items check gives an item the one line of its part near its quote that starts with the number
   it names, and takes out a `\u` with fewer than four hex digits with its digits. The items rule
   asks for quotes of five to twelve words, copied letter by letter (the near check still needs
   15 characters). cleaning-sanctions' count fact takes 37 only as the count, not "סעיף 37", a
   line, a list or a range. Each change has unit tests that fail without it.
2. **The cassettes (31485b0, `0100-t-record-4.md`).** The hint changed Flash's contract-summary and
   cleaning-sanctions; diary-planted-nothing on Flash failed only because the replay learns Flash's
   output limit in contract-summary's whole read, and passed once that was recorded. Flash-Lite's
   cleaning-sanctions facts were rewritten by `npm run eval:recheck`. `npm run eval:replay` with
   no key: 90 of 90, run one case at a time since 235dbd2 (4. below). No recording holds a read
   that lists items. 89,199 input tokens.
3. **The pass^3 of T's whole-read cases (`0100-t-live-4.md`).** contract-summary 3 of 3 on both
   models, every fact; diary-timeline 3 of 3 on Flash and 2 of 3 on Flash-Lite. **The whole-read
   gate is met on Flash, not on Flash-Lite.** 992,188 input tokens.
4. **The lookups (`0100-t-live-lookups.md`).** contract-penalties, contract-largest-en, log-hebrew
   and log-failover, two runs on each model: no whole read in 16 runs (none in the cassettes nor
   in `0100-t-record-3.md`), every run passed. 637,153 input tokens.
5. **Round 6 of the items reads (`0100-t-direct.md`, `0100-t-items-6.json`).** Flash-Lite: 27 of
   27 replies parsed, contract-1 37 in 3 of 3 reads, cleaning-1 36, 24 and 37. Flash: 37 in 6 of
   6. **The items gate is met.** 114,615 input tokens.

The live calls after c1fbbb5 took 1,833,155 input tokens; T's live calls, 10,634,007 in all.

## What is left

1. **The whole-read gate on Flash-Lite.** diary-timeline's run 2 read the diary whole, but two of
   its five part replies were `NOTHING RELEVANT` (5 output tokens each), and the answer lost the
   incidents of 11 and 19 October. The chat did what the gate needs; Gemini 3.5 Flash-Lite as the
   part reader dropped the parts. No prompt was changed for it. The proposal: in
   `analyzeWholeDocument` (an answer read), read once more a part that replies `NOTHING RELEVANT`
   when the task needs all of the file, within `maxRequests`: no text sent changes, it costs a
   request of a part for each such reply (about 12,000 tokens on the diary), and the reader's
   replies vary from run to run (runs 1 and 3 kept the five dates). Measure it with direct reads of
   diary-1 (about 160,000 input tokens for three) and `npm run eval:live -- --k 3 --cases
   diary-timeline,contract-summary` on both models (about 600,000). The other way, a notes rule
   that a part is always relevant to a full summary or a timeline, changes the part prompt and so
   every whole-read cassette.
2. **The hint on a very large file.** The tool set can read the 33,500-line service log whole (24
   parts, about 2.1 million tokens of text), so a cut read of it carries the hint. No lookup read it
   whole, but a question that does would spend that much. Consider leaving the hint off past a price
   (a number of parts, or the room the question has left), or naming the parts in it.
3. **Not gated, measured:** cleaning-1 run 2 of Flash-Lite lost a part of 10 sanctions to
   `NOTHING RELEVANT` (as in 1.), and 4 quotes of round 6 left words out without "…", which the near
   check cannot count. In the chat, Flash-Lite read the agreement whole as an answer (31 and 35)
   and never chose `output: "items"`; Flash read it whole after the hint in 2 of 3 runs, 37 each.
   Flash's diary-planted-nothing reads a range in its last tool turn, where the hint cannot be used
   (1 of 3 passed).
4. **The replay's order.** The output limit Flash needs for a part read (`THINKING_OUTPUT_TOKENS`)
   is learned once in a process, so the Flash cassettes of diary-planted-nothing and
   cleaning-sanctions replay only after contract-summary's part reads, which learn it. Replayed 8
   cases at a time, cleaning-sanctions raced it and failed 1 replay of 5; the replay now runs one
   case at a time, in the order of the cases (235dbd2, `vitest.evals.config.ts`), and passed 90 of
   90 in 5 of 5. A replay of those cases without contract-summary (`--cases cleaning-sanctions`) still
   fails them with "prompt changed", and so would a recording of contract-summary that learns
   nothing. Forgetting what was learned before each case, in the eval runner, would end that; it
   needs a hook into `src/output-limit.ts` and the two cassettes recorded again.
