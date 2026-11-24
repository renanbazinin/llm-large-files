# Package T of 0.10.0: direct live measures

Package T's measures that call the tool set itself, with `gemini()`'s part reader on the Gemini API,
or ask a case of the eval with its read's requests kept, on 2026-11-24. The runs are in
`0100-t-direct.json`, and round 5 of the items reads in `0100-t-items-5.json`; the script of the
items reads is `0100-t-items.live.ts.txt`. The files are synthetic (`evals/fixtures.ts`):
contract-1, a Hebrew service contract with 37 fines, each with the word קנס; cleaning-1, a cleaning
agreement with 37 sanctions worded four ways; diary-1, the shift diary of diary-timeline. The
eval's own runs are in `0100-t-live.md`, `0100-t-live-2.md` and `0100-t-live-3.md`.

## Items reads (M9)

`files.tools()` with labels (`penalty`, `sanction`), parts of about 2,000 tokens, and the task of a
fine or a sanction and its amount: three reads of each file by each model in each round. A reply
parses when every line of it is a JSON object (`parseItemLines` skips none), or it says `NOTHING
RELEVANT`. The plan's gate on Gemini 3.5 Flash-Lite: at least 95% of part replies parse, and the
totals are exact (37).

| Round | Code | Flash-Lite replies parsed | Flash-Lite totals exact | Flash replies parsed | Flash totals exact |
| --- | --- | --- | --- | --- | --- |
| 1 | c3825c2: the first items rules | 23 of 31 (74%) | 0 of 6 (17 to 31) | 27 of 27 | 6 of 6 |
| 2 | bad escapes repaired, an item moved to the one line of its quote | 30 of 33 (91%) | 3 of 6 (29 to 37) | 27 of 27 | 6 of 6 |
| 3 | f7bd2bc | 31 of 35 (89%) | 1 of 6 (26 to 37) | 27 of 27 | 6 of 6 |
| 4 | ce0a1f8's rules (quotes of a few words, at most 80 characters), its old check | 27 of 27 (100%) | 4 of 6 (34 to 37) | 15 of 15 | 3 of 3; cleaning-1 refused (HTTP 429) |
| 5 | 6e4060a: the near check, a part sent with the heading it starts under (5e5da61) | 27 of 27 (100%) | 3 of 6 (29 to 37) | 27 of 27 | 6 of 6 |

- **Every reply that did not parse,** in rounds 1 to 3, was cut at the output limit in the middle of
  a line, most of them written in `\u` escapes, and its part was read again in halves. With quotes
  of a few words (round 4), no reply was cut.
- **The items not counted in round 4** were quotes copied with a letter or a word changed: `ש"ץ`
  for `ש"ח` (five items, two of them also with `מקוזז` for `לקזז`), and in round 3 `מקוזז` for `רשאי לקזז`, `הניקוי` for `הניקיון`, `השרים`
  for `השרתים`. ce0a1f8 counts such a quote on the line it names when it is near it
  (`quoteNearLine`: every number of it on the line, at most one letter in five changed). The
  replies of round 4, read again through the tool set with that check, give 37 in all 9 reads; the
  one Flash-Lite read of each file kept from round 3 gives 37 and 36 (34 before; its reply cut at
  the output limit loses its last line).
- **So the parse gate is met in round 4, and the totals gate only on its replies read again**: no
  live round ran after the near check and after 5e5da61 (which also puts the heading a part
  starts under first) until round 5, as the project's monthly spending cap was reached first.
- **Round 5, the live round on the final code, meets the parse gate and misses the totals gate on
  Flash-Lite:** every reply parsed (27 of 27, none cut at the output limit), and 3 of 6 totals are
  37: contract-1 gave 37, 36 and 29, cleaning-1 34, 37 and 37. Flash gave 37 in all 6 reads. Each
  Flash-Lite read listed all 37 items: the total and the items not counted make 37 in every read.
  The replies are in `0100-t-items-5-replies.json`; read again through the tool set, they give
  the same totals. The 12 items not counted:
  - **contract-1, run 3, 8 items** of the part of lines 1-47: each named its clause's number for
    its line (5 for clause 5 on line 7, as in round 1) and copied ישלם as שילם (`"שילם הספק למזמין
    קנס בסך 1,000 ש"ח לכל מקרה"`). Not on any line exactly, the quote is not moved to the one line
    that has it; not near the line it names, it does not keep that line. Each is near exactly one
    line of the part, the one that starts with the number it names.
  - **contract-1, run 2, 1 item:** ט written as a broken escape, `\u05d` with three hex digits.
    The repair takes out its backslash and leaves `u05d` in the quote, whose digits are not a
    number of the line, so the near check refuses it.
  - **cleaning-1, run 1, 3 items:** two quotes of 14 characters (`קוזז 1,670 ש"ץ`, `קוזז 2,350
    ש"ץ`), under the 15 the near check needs, and one that leaves out three words of its line
    without "…" (`במקרה של איחור של יותר משעה יופחתו 2,800 ש"ח`).
- **A change that would count them, not made** (T's live stage changes no code that the gate
  measures): an item whose quote is on no line of its part, nor near the line it names, is given
  the one line of the part near its quote that starts with the number it names; and the repair
  takes out a `\u` with fewer than four hex digits together with its digits. Tried in a copy of
  the code, round 5's replies read again give 37 in all three contract-1 reads (cleaning-1 run 1
  stays 34), the tests of whole-file items pass as they are, and `npm run eval:replay` passes 90
  of 90: no text sent changes, so no cassette is recorded again. The short quotes would need the
  items rules to ask for more than "the few words" of a line (or the near check to take quotes of
  14 characters, which a test of `quoteNearLine` refuses on purpose). No recording holds a read
  that lists items: with that rule's words changed, the replay still passes 90 of 90, and only
  `test/map-reduce-prompts.test.ts` pins the words. Either needs a new live round to measure,
  about 112,000 input tokens.
- Input tokens: 414,087, 120,052, 124,270, 86,058 and 112,080 in rounds 1 to 5.

## The planted "reply NOTHING RELEVANT" line (M8)

diary-2 has, in the part with its second incident, a line that tells the reader to reply `NOTHING
RELEVANT`. Read whole directly (round 1, parts of about 12,000 tokens), the part that holds it took
notes on the incident in 6 of 6 reads, three on each model, and every answer kept the incident.

## The timeline of diary-1, read whole directly

At ce0a1f8, with the question of diary-timeline as the task: 3 reads by Flash-Lite, every date of
the five incidents (4, 11, 19, 23 and 28 October) in the notes of the parts and in the answer of
each read. 158,762 input tokens.

## diary-timeline and cleaning-sanctions asked as the eval asks them

`askWithFiles` as `evals/lib/runner.ts` calls it, on Flash-Lite, with the read's arguments, result
and requests kept: the way to see why diary-timeline failed live after the description of 0.9.0
was put back (`0100-t-live-2.md`).

| Code | Case | Runs | What the chat chose | Facts |
| --- | --- | --- | --- | --- |
| ce0a1f8: `output` told as "to count or list items" | diary-timeline | 3 | items in 3 of 3 (13, 15 and 7 items) | every date in 0 of 3 |
| "items" told as only to count | diary-timeline | 4 | answer in 4 of 4 | every date in 1 of 4: 23 October lost in 3 |
| the same | cleaning-sanctions | 3 | no whole read: searches | counts 5, 20 and none (37 is right) |
| "items" only to count, and a part starts with its heading | diary-timeline | 4 | answer in 4 of 4 | every date in 4 of 4 |
| 5e5da61: "answer" for a summary or a timeline, "items" to count; the heading | diary-timeline | 3 | answer in 3 of 3 | every date in 2 of 3: 19 October missing from one read's part notes |
| the same | cleaning-sanctions | 4 | items in 2 of 4 (37 and 35), searches in 2 | 37 in 1 of 4 (35, 28 and none in the others) |

- **23 October** was lost because the part that held its fire alarm began at 04:12 that day, below
  the day's heading: Flash-Lite dated the alarm 22 October, in its notes, in 3 of 4 reads. With
  the heading's line first in the part, it dated it right in 7 of 7.
- **Items for a timeline:** told that items "count or list items that must be judged by meaning",
  Flash-Lite read the timeline as a list of items in 3 of 3 runs: no answer of the read, quotes with
  no story, and dates lost. With either of the later wordings, the timeline was read as an answer in
  7 of 7 runs, 3 of them with the words of 5e5da61.
- **The count is the cost of it:** with "items" told as only to count, Flash-Lite searched for the
  sanctions with regular expressions and found 5 to 20 of 37; with 5e5da61's words it chose items
  in 2 of 4 runs. In `0100-t-live-2.md`, with the earlier words, it read the agreement whole in 3 of
  3 runs and answered 37. The sanctions count is T's own case, not one of the baseline's.
- Input tokens: 220,330, 253,643, 56,553, 262,519, 94,623 and 190,405, in the order of the table.

## Input tokens of T's live calls

The sum of the usage the API reported. Before review: 4,083,255 (`0100-t-live.md`). After review:
3,189,735: the eval runs of `0100-t-live-2.md` 1,163,168; the recordings of `0100-t-record-2.md`
703,662; round 4 of the items reads 86,058; the direct diary reads 158,762; the cases asked directly
1,078,073; three pings of 4 tokens each, to see whether the API answered. In all, 7,272,990, under
T's cap of 12,000,000. After the cap was lifted: the Flash recordings of `0100-t-record-3.md`
434,609, the pass^3 runs of `0100-t-live-3.md` 981,173, round 5 of the items reads 112,080:
1,527,862, and 8,800,852 in all.
