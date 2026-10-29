import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const capture = fileURLToPath(new URL("./pumpportal-capture.mjs", import.meta.url));
const messages = ["null", "42", "[]", '"notice"', "not JSON",
  JSON.stringify({ txType: "buy", mint: "11111111111111111111111111111111", solAmount: 1 })];
function frame(opcode, body) {
  assert.ok(body.length < 126);
  return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
}
async function packet(t) {
  const root = mkdtempSync(join(tmpdir(), "pumpportal-null-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sockets = new Set();
  const server = http.createServer();
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] +
      "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
      `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", () => {});
    socket.end(Buffer.concat([...messages.map(text => frame(1, Buffer.from(text))),
      frame(8, Buffer.from([0x03, 0xe8]))]));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  // Native WebSocket and real frames; redirect only the destination to loopback.
  const preload = `const Native = globalThis.WebSocket;
    globalThis.WebSocket = class extends Native {
      constructor() { super('ws://127.0.0.1:${server.address().port}'); }
    };`;
  const output = join(root, "packet");
  const child = spawn(process.execPath, ["--import",
    `data:text/javascript,${encodeURIComponent(preload)}`, capture,
    "--duration", "3", "--output", output], {
    env: { PUMPPORTAL_API_KEY: "offline-placeholder" },
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.resume();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  assert.equal(result.code, 0, stderr);
  const read = name => JSON.parse(readFileSync(join(output, name), "utf8"));
  return { output, read };
}

test("each received frame is retained once, including JSON null and non-JSON text", async t => {
  const { read } = await packet(t);
  const events = read("events.json");
  assert.equal(events.length, messages.length);
  assert.deepEqual(events.map(({ receivedAt, ...event }) => event), [
    { data: null }, { data: 42 }, { data: [] }, { data: "notice" },
    { raw: "not JSON" }, { data: JSON.parse(messages.at(-1)) },
  ]);
  const summary = read("summary.json");
  assert.equal(summary.total_events, 6);
  assert.deepEqual(summary.event_types, { unknown: 5, buy: 1 });
  assert.equal(read("token-index.json")[0].event_count, 1);
});

test("the generated verifier accepts a packet retaining JSON null", async t => {
  const { output } = await packet(t);
  const result = spawnSync("python3", [join(output, "verify.py")], {
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /All checks passed/);
});
