import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const capture = fileURLToPath(new URL("./pumpportal-capture.mjs", import.meta.url));
// Exercise the real CLI and filesystem without opening a socket or reading a key.
const preload = `
import { writeFileSync } from 'node:fs';
globalThis.WebSocket = class extends EventTarget {
  constructor() {
    super();
    writeFileSync(process.env.CAPTURE_SOCKET_MARKER, 'constructed');
    setTimeout(() => {
      this.dispatchEvent(new Event('open'));
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        txType: 'create', mint: '11111111111111111111111111111111', name: 'Offline'
      }) }));
      this.close();
    }, 0);
  }
  send() {}
  close() { this.dispatchEvent(Object.assign(new Event('close'), { code: 1000 })); }
};`;

function run(output, marker) {
  return spawnSync(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(preload)}`,
    capture, "--output", output, "--duration", "30",
  ], {
    env: { PUMPPORTAL_API_KEY: "offline-placeholder", CAPTURE_SOCKET_MARKER: marker },
    encoding: "utf8", timeout: 5000,
  });
}
function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), "pumpportal-output-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function snapshot(dir) {
  return Object.fromEntries(readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name)).toString("hex")]));
}

test("a new nested destination produces a consistent packet; retry preserves every byte", t => {
  const root = temporary(t);
  const output = join(root, "nested", "capture");
  const first = run(output, join(root, "socket-first"));
  assert.equal(first.status, 0, first.stderr);
  const events = JSON.parse(readFileSync(join(output, "events.json"), "utf8"));
  const summary = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
  assert.equal(events.length, 1);
  assert.equal(summary.total_events, events.length);
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  assert.equal(Object.keys(manifest).length, 5);
  for (const [name, hash] of Object.entries(manifest)) {
    assert.equal(createHash("sha256").update(readFileSync(join(output, name))).digest("hex"), hash);
  }
  const before = snapshot(output);
  const marker = join(root, "socket-retry");
  const retry = run(output, marker);
  assert.notEqual(retry.status, 0, "a repeat capture must refuse the existing packet");
  assert.match(retry.stderr, /already exists/i);
  assert.equal(existsSync(marker), false, "must refuse before constructing a WebSocket");
  assert.deepEqual(snapshot(output), before);
});

test("a partially written packet is preserved without starting capture", t => {
  const root = temporary(t);
  const output = join(root, "partial");
  mkdirSync(output);
  writeFileSync(join(output, "events.json"), "retained partial bytes\n");
  const before = snapshot(output);
  const marker = join(root, "socket");
  const result = run(output, marker);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already exists/i);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(snapshot(output), before);
});

test("existing empty directories and files are refused before capture", t => {
  const root = temporary(t);
  for (const kind of ["directory", "file"]) {
    const output = join(root, kind);
    if (kind === "directory") mkdirSync(output);
    else writeFileSync(output, "keep");
    const marker = join(root, `${kind}-socket`);
    const result = run(output, marker);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists/i);
    assert.equal(existsSync(marker), false);
    if (kind === "directory") assert.deepEqual(readdirSync(output), []);
    else assert.equal(readFileSync(output, "utf8"), "keep");
  }
});
