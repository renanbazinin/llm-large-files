// "llm-large-files/testing": fakes for the tests of an app that uses the library, as the library's
// own tests use them. A scripted model (fakeModel), a fetch for the real adapters (fakeFetch), and
// test documents, and the checks of a store (documentStoreChecks). Nothing here depends on a test
// framework: it works with Vitest, Jest or node:test.
export { calls, fakeModel, httpError, says, serviceLog, utf8 } from "./fake-model.js";
export type { FakeModel, Scripted } from "./fake-model.js";
export { fakeFetch, sse } from "./fake-fetch.js";
export type { FakeFetch, FakeReply, Sent } from "./fake-fetch.js";
// The checks a DocumentStore must pass, for the tests of a store of your own. New in 0.9.0.
export { documentStoreChecks } from "./store-checks.js";
export type { DocumentStoreCheck, DocumentStoreChecksOptions, StoreCheckEnvironment, StoreCheckPart } from "./store-checks.js";
