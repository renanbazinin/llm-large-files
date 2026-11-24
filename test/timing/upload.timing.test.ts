// The test of the upload handler that holds a client to the clock (from test/limits-0.8.2.test.ts):
// a client in a process of its own sends a few bytes every 20 ms, within an idle limit of 200 ms.
import { spawn } from "node:child_process";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "llm-large-files";
import type { createDocumentHandlers } from "llm-large-files/node";
import { until, uploadServer } from "../upload-server.js";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("maxPendingUploadBytes of the upload handler (0.8.2)", () => {
  const start = (handlerOptions: Parameters<typeof createDocumentHandlers>[1], maxUploadBytes = 4_000, store = new MemoryDocumentStore()) =>
    uploadServer(handlerOptions, maxUploadBytes, store, (made) => (server = made));

  it("does not answer 408 a body that arrived while the server's thread was held", async () => {
    const { state, url } = await start({ uploadIdleTimeoutMs: 200 });
    const { port } = new URL(url);
    // A client in a process of its own sends 10 bytes every 20 ms, 400 in all.
    const client = spawn(process.execPath, ["-e", `
      const socket = require("node:net").connect(${port}, "127.0.0.1", () => {
        socket.write("POST /upload HTTP/1.1\\r\\nHost: x\\r\\nX-File-Name: steady.txt\\r\\nContent-Length: 400\\r\\n\\r\\n");
        let sent = 0;
        const timer = setInterval(() => { socket.write("x".repeat(10)); if (++sent === 40) clearInterval(timer); }, 20);
      });
      let answer = "";
      socket.on("data", (chunk) => { answer += chunk; if (answer.includes("\\r\\n\\r\\n")) { process.stdout.write(answer.split("\\r\\n")[0]); socket.destroy(); } });
    `]);
    let status = "";
    client.stdout.on("data", (chunk: Buffer) => (status += chunk.toString()));
    // 250 ms in, this thread is held for 500 ms, inside a turn of the loop where I/O is read.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await new Promise<void>((resolve) => setImmediate(() => {
      const heldUntil = performance.now() + 500;
      while (performance.now() < heldUntil) { /* held */ }
      resolve();
    }));
    await until(() => state.running === 1);
    state.releaseAll();
    await new Promise<void>((resolve) => client.on("exit", () => resolve()));
    expect(status).toMatch(/^HTTP\/1\.1 201 /);
  }, 15_000);
});
