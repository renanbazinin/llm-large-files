// Where the documents of a chat are placed from one question to the next, so that the start of its
// requests stays the same (`PlacementState`, in types.ts). New in 0.10.0: the version is here, and
// the planning that keeps the state is not written yet.

/** The version of `PlacementState` this package writes, and the only one it reads. New in 0.10.0. */
export const PLACEMENT_STATE_VERSION = 1;
