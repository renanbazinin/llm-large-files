// The fakes the tests use ship in the package, as "llm-large-files/testing" (src/testing/). This
// file keeps the tests' imports from "./fake-model.js" as they were.
export { calls, fakeModel, httpError, says, serviceLog, utf8 } from "llm-large-files/testing";
export type { FakeModel, Scripted } from "llm-large-files/testing";
