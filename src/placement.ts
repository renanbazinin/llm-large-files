// Where the documents of a chat are placed from one question to the next, so that the start of its
// requests stays the same (`PlacementState`, in types.ts). New in 0.10.0. Planning reads and writes
// the state (src/prepare.ts); what is here is pure: reading a stored state, the next state after a
// question, and when the stored rounds of earlier questions are sent as stand-ins (in batches, so
// that the earlier turns of a chat change seldom).
import { createHash } from "node:crypto";
import { stubResult } from "./evidence.js";
import type { ModelMessage, ModelToolRound, ToolAnswer } from "./model.js";
import { TOOL_ORDER, toolsInOrder } from "./plan.js";
import type { DocumentPlan, PlacementState, ToolName } from "./types.js";

/** The version of `PlacementState` this package writes, and the only one it reads. New in 0.10.0. */
export const PLACEMENT_STATE_VERSION = 1;

/**
 * The `head` of a state (`PlacementState.head`): a hash of the text of the first user turn of the
 * chat, as 32 hex digits of its SHA-256. A list of messages trimmed or swapped at its start has
 * another, and a state kept for the list as it was is then not used.
 */
export function placementHead(firstUserText: string): string {
  return createHash("sha256").update(firstUserText, "utf8").digest("hex").slice(0, 32);
}

/** The state of a chat that has placed nothing yet. */
export function emptyPlacement(head: string): PlacementState {
  return { version: PLACEMENT_STATE_VERSION, head, inline: [], cards: [], tools: [], stubbedThrough: 0 };
}

const KNOWN_TOOLS = new Set<string>(TOOL_ORDER);

/** A list of distinct strings, from a value that is an array of strings; undefined for anything else. */
function idList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return [...new Set(value as string[])];
}

/**
 * A state as this package reads it: a copy of `value` when it is a state of version 1 of the right
 * shape, with each ID once (an ID in both lists counts as sent whole) and the tools in their
 * order. Undefined for anything else: another version, a field missing or of another type, a
 * tool this package does not know. Fields it does not know are left out. The head is not checked
 * here: see `readPlacement`.
 */
export function checkedPlacement(value: unknown): PlacementState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const given = value as Record<string, unknown>;
  if (given.version !== PLACEMENT_STATE_VERSION || typeof given.head !== "string") return undefined;
  const inline = idList(given.inline);
  const cards = idList(given.cards);
  const tools = idList(given.tools);
  const stubbed = given.stubbedThrough;
  if (!inline || !cards || !tools || !tools.every((name) => KNOWN_TOOLS.has(name))) return undefined;
  if (typeof stubbed !== "number" || !Number.isSafeInteger(stubbed) || stubbed < 0) return undefined;
  if (given.nativeRefused !== undefined && given.nativeRefused !== true) return undefined;
  const sentWhole = new Set(inline);
  return {
    version: PLACEMENT_STATE_VERSION,
    head: given.head,
    inline,
    cards: cards.filter((id) => !sentWhole.has(id)),
    tools: toolsInOrder(tools),
    stubbedThrough: stubbed,
    ...(given.nativeRefused === true ? { nativeRefused: true as const } : {}),
  };
}

/** Why a stored state was not used (`readPlacement`). */
export type PlacementIgnored = "version" | "head" | "invalid";

/**
 * The state to plan a question with, from the one the application kept (`AskOptions.placement`)
 * and the `head` of the chat as it is now (`placementHead` of its first user turn). The state is
 * used when it is of this version, of the right shape, and of this head; otherwise the question is
 * planned afresh from an empty state, and `ignored` says why, for a `placement_changed` notice.
 * No state at all is an empty one, and nothing to tell. It never throws: the state only saves cost.
 */
export function readPlacement(given: unknown, head: string): { state: PlacementState; ignored?: PlacementIgnored } {
  if (given === undefined || given === null) return { state: emptyPlacement(head) };
  const version = typeof given === "object" ? (given as { version?: unknown }).version : undefined;
  if (version !== PLACEMENT_STATE_VERSION) return { state: emptyPlacement(head), ignored: typeof version === "number" ? "version" : "invalid" };
  const state = checkedPlacement(given);
  if (!state) return { state: emptyPlacement(head), ignored: "invalid" };
  if (state.head !== head) return { state: emptyPlacement(head), ignored: "head" };
  return { state };
}

/**
 * The state after a question was planned with `given` (or with none): the documents sent whole and
 * searched, each in the order first placed, the documents of `ids` placed for the first time added
 * in their order, a document sent whole before and searched now moved to the cards, those found
 * missing left out (deleted, expired, or another owner's). Documents of earlier questions that this
 * one does not name keep their place. `tools` are the tools declared now, those of `given` among
 * them. `stubbedThrough` and `nativeRefused` are kept: the loop sets them.
 */
export function nextPlacement(given: PlacementState | undefined, head: string, question: { ids: readonly string[]; plan: Pick<DocumentPlan, "inline" | "searchable">; missing: readonly string[]; tools: readonly ToolName[] }): PlacementState {
  const gone = new Set(question.missing);
  const sentWhole = new Set(question.plan.inline.map((meta) => meta.id));
  const searched = new Set(question.plan.searchable.map((meta) => meta.id));
  const before = given?.inline ?? [];
  const inline = before.filter((id) => !gone.has(id) && !searched.has(id));
  const cards = [...(given?.cards ?? []).filter((id) => !gone.has(id) && !sentWhole.has(id)), ...before.filter((id) => !gone.has(id) && searched.has(id))];
  const placed = new Set([...inline, ...cards]);
  for (const id of question.ids) {
    if (placed.has(id)) continue;
    if (sentWhole.has(id)) inline.push(id);
    else if (searched.has(id)) cards.push(id);
    placed.add(id);
  }
  return {
    version: PLACEMENT_STATE_VERSION,
    head,
    inline,
    cards,
    tools: toolsInOrder([...given?.tools ?? [], ...question.tools]),
    stubbedThrough: given?.stubbedThrough ?? 0,
    ...(given?.nativeRefused ? { nativeRefused: true as const } : {}),
  };
}

/**
 * The documents sent whole in `before` that `after` searches: they moved to the cards because they
 * no longer fit, even with every earlier round as its stand-in. The loop says so in a
 * `placement_changed` notice and in a note of the question's turn.
 */
export function movedToCards(before: PlacementState | undefined, after: PlacementState): string[] {
  const cards = new Set(after.cards);
  return (before?.inline ?? []).filter((id) => cards.has(id));
}

/** Free room under this share of the window starts a batch of stand-ins. */
export const STUB_START_FREE = 0.15;
/** A batch of stand-ins ends once this share of the window is free, or every earlier unit is a stand-in. */
export const STUB_END_FREE = 0.4;

type Size = { tokens: number; bytes: number };

/**
 * The share of `limit` that a request of size `used` leaves free: the less free of its tokens and
 * of its bytes. Below 0 when it is over. A limit that is not a positive finite number leaves all free.
 */
export function freeShare(used: Size, limit: Size): number {
  const share = (taken: number, most: number) => (most > 0 && Number.isFinite(most) ? (most - taken) / most : 1);
  return Math.min(share(used.tokens, limit.tokens), share(used.bytes, limit.bytes));
}

/**
 * How many of `units` (the earlier questions of a chat, or the earlier rounds of a question),
 * oldest first, are sent as stand-ins: `stubbed` are already, and stay so. While the request leaves
 * at least `STUB_START_FREE` of `limit` free, no more. Below it, a batch: the oldest units that are
 * not yet stand-ins become stand-ins, one at a time, until `STUB_END_FREE` is free or every unit is
 * one. So the earlier turns of a chat change in a few batches, not a little at every request.
 * `other` is everything else in the request; each unit gives its size in full and as stand-ins.
 * A `stubbed` that is not a number counts as 0, and Infinity as every unit.
 */
export function stubbedFor(units: ReadonlyArray<{ full: Size; standIn: Size }>, other: Size, limit: Size, stubbed = 0): number {
  let count = typeof stubbed !== "number" || Number.isNaN(stubbed) ? 0 : Math.min(units.length, Math.max(0, Math.trunc(stubbed)));
  const used = { ...other };
  units.forEach((unit, index) => {
    const size = index < count ? unit.standIn : unit.full;
    used.tokens += size.tokens;
    used.bytes += size.bytes;
  });
  if (freeShare(used, limit) >= STUB_START_FREE) return count;
  while (count < units.length && freeShare(used, limit) < STUB_END_FREE) {
    const unit = units[count]!;
    used.tokens += unit.standIn.tokens - unit.full.tokens;
    used.bytes += unit.standIn.bytes - unit.full.bytes;
    count++;
  }
  return count;
}

/**
 * A tool round with each result that a stand-in shortens (`stubResult`) replaced by its stand-in,
 * and its pages dropped with it: the round as it is sent once stubbed, and as planning counts the
 * stored rounds of earlier questions. The same object when nothing in it can be shortened.
 */
export function standInRound(round: ModelToolRound): ModelToolRound {
  let touched = false;
  const answers = round.answers.map((answer): ToolAnswer => {
    const stub = stubResult(answer.call, answer.result, (answer.files?.length ?? 0) > 0);
    if (!stub) return answer;
    touched = true;
    return { call: answer.call, result: stub };
  });
  return touched ? { ...round, answers } : round;
}

/**
 * The tool rounds of each question of `messages`, in order: the first array holds those after the
 * first user turn, the next those after the second, and so on, with an empty array for a question
 * that made none. Questions are counted from the start of `messages`, as `stubbedThrough` counts
 * them; a round before any user turn is left out.
 */
export function roundsByQuestion(messages: readonly ModelMessage[]): ModelToolRound[][] {
  const questions: ModelToolRound[][] = [];
  for (const message of messages) {
    if (message.role === "user") questions.push([]);
    else if (message.role === "tools") questions.at(-1)?.push(message);
  }
  return questions;
}

/**
 * `messages` with the tool rounds of the first `questions` questions as their stand-ins
 * (`standInRound`): `stubbedThrough` of them, as a question sends them, or every one, as planning
 * counts the stored rounds. A new array; the messages that do not change are the same objects.
 */
export function withStandIns(messages: readonly ModelMessage[], questions = Number.POSITIVE_INFINITY): ModelMessage[] {
  let question = 0;
  return messages.map((message) => {
    if (message.role === "user") question++;
    return message.role === "tools" && question >= 1 && question <= questions ? standInRound(message) : message;
  });
}
