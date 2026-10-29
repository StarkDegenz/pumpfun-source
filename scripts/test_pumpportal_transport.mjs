import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const capture = fileURLToPath(new URL("./pumpportal-capture.mjs", import.meta.url));
const message = JSON.stringify({ txType: "buy", mint: "11111111111111111111111111111111", solAmount: 1 });
function frame(opcode, body) {
  assert.ok(body.length < 126);
  return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
}

async function run(t, mode) {
  const root = mkdtempSync(join(tmpdir(), "pumpportal-transport-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sockets = new Set();
  const server = http.createServer((_req, res) => { res.writeHead(401); res.end(); });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  if (mode !== "reject") server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] +
      "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
      `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", () => {});
    const frames = [frame(1, Buffer.from(message))];
    if (mode === "normal") frames.push(frame(8, Buffer.from([0x03, 0xe8])));
    if (mode === "no-code") frames.push(frame(8, Buffer.alloc(0)));
    // Abrupt mode sends a real event, then EOF without a WebSocket close frame.
    socket.end(Buffer.concat(frames));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  // Keep Node's actual WebSocket implementation and timers. Redirect only its URL
  // to the loopback fixture; the CLI sees a synthetic placeholder, never a real key.
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
  assert.equal(result.signal, null, stderr);
  const summary = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
  const events = JSON.parse(readFileSync(join(output, "events.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  for (const [name, hash] of Object.entries(manifest)) {
    assert.equal(createHash("sha256").update(readFileSync(join(output, name))).digest("hex"), hash);
  }
  assert.equal(summary.total_events, events.length);
  return { ...result, summary, events };
}

test("HTTP 401 handshake failure exits unsuccessfully and records the transport failure", async t => {
  const result = await run(t, "reject");
  assert.equal(result.code, 1);
  assert.equal(result.events.length, 0);
  assert.equal(result.summary.websocket.failed, true);
  assert.equal(result.summary.websocket.close_code, 1006);
  assert.equal(result.summary.websocket.had_error, true);
});

test("connection loss preserves received events but reports failure", async t => {
  const result = await run(t, "abrupt");
  assert.equal(result.code, 1);
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0].data, JSON.parse(message));
  assert.equal(result.summary.websocket.failed, true);
  assert.equal(result.summary.websocket.close_code, 1006);
});

for (const [mode, closeCode] of [["normal", 1000], ["no-code", 1005]]) {
  test(`${mode} close retains successful capture behavior`, async t => {
    const result = await run(t, mode);
    assert.equal(result.code, 0);
    assert.equal(result.events.length, 1);
    assert.equal(result.summary.websocket.failed, false);
    assert.equal(result.summary.websocket.close_code, closeCode);
    assert.equal(result.summary.websocket.had_error, false);
  });
}
