// The ID a client gives one question of a chat (`AskOptions.questionId`, H14), checked in one
// place for the tool loop and the question registry. A module of its own, so that ask.ts and
// questions.ts do not import each other. New in 0.99.9.

/**
 * What a question ID may be: 1 to 128 characters, letters, digits, ".", "_", ":" and "-",
 * starting with a letter or a digit. A UUID fits. New in 0.99.9.
 */
export const QUESTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const NOT_A_QUESTION_ID = "questionId must be a string of 1 to 128 characters: letters, digits, \".\", \"_\", \":\" or \"-\", starting with a letter or a digit, such as a UUID the client made for this question.";

/** `value` when it is a question ID, else undefined. */
export function validQuestionId(value: unknown): string | undefined {
  return typeof value === "string" && QUESTION_ID_PATTERN.test(value) ? value : undefined;
}

/** Throws the TypeError of a question ID that is given and is not one. */
export function checkQuestionId(value: unknown): void {
  if (value !== undefined && validQuestionId(value) === undefined) throw new TypeError(NOT_A_QUESTION_ID);
}
