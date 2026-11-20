// Loads pdf.js (through unpdf) and pdf-lib before the tests of a file run.
//
// The library imports them on first use, and each test file runs in a process of its own, so
// without this the first PDF test of each file pays for the load inside its 5 s timeout. On a
// cold disk (a fresh `npm ci`, files the virus scanner has not seen yet) with every worker
// loading them at once, that load alone took 11 to 14 s. A test file that imports this module
// first waits for the load while it is collected, where no timeout applies.
import { getResolvedPDFJS } from "unpdf";

await Promise.all([getResolvedPDFJS(), import("@cantoo/pdf-lib")]);
