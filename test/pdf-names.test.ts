// The tests of names that take long to decode, and of the files that hold them, are in
// test/timing/pdf.timing.test.ts: they hold the work to the clock.
import { describe, expect, it } from "vitest";
import { canonicalName } from "../src/pdf-pages.js";

/** A name that loses one "#23" each time it is decoded: `levels` + 1 decodings make it "A". */
const nested = (levels: number) => `#${"23".repeat(levels)}41`;

describe("PDF names are decoded in time that grows with their length", () => {
  it("reads a name as the characters it stands for, also when a library kept an escape", () => {
    expect(canonicalName("Im1")).toBe("Im1");
    expect(canonicalName("I#31")).toBe("I1");
    expect(canonicalName("A#20B")).toBe("A B");
    // pdf-lib may hand over "#41" for a name the file wrote "#2341": both stand for "A".
    expect(canonicalName(nested(1))).toBe("A");
    expect(canonicalName(nested(2))).toBe("A");
  });
});
