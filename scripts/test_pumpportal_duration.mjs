import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const capture = fileURLToPath(new URL("./pumpportal-capture.mjs", import.meta.url));
const preload = `
import { writeFileSync } from 'node:fs';
globalThis.WebSocket = class extends EventTarget {
  constructor() {
    super();
    writeFileSync(process.env.SOCKET_MARKER, 'constructed');
    if (process.env.CLOSE_EARLY === 'yes') setImmediate(() => this.close());
  }
  send() {}
  close() { this.dispatchEvent(Object.assign(new Event('close'), { code: 1000 })); }
};`;

function run(t, args, early = false) {
  const root = mkdtempSync(join(tmpdir(), "pumpportal-duration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "capture");
  const marker = join(root, "socket");
  const result = spawnSync(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(preload)}`,
    capture, "--output", output, ...args,
  ], {
    env: { PUMPPORTAL_API_KEY: "offline-placeholder", SOCKET_MARKER: marker,
      CLOSE_EARLY: early ? "yes" : "no" },
    encoding: "utf8", timeout: 5000,
  });
  return { result, output, marker };
}

test("overflowing duration is rejected instead of a successful one-millisecond capture", t => {
  // Uses Node's real timer: on the base, 2,147,484,000 ms overflows to 1 ms.
  const { result, output, marker } = run(t, ["--duration", "2147484"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /duration/i);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(output), false);
});

test("invalid and missing duration values fail before creating a packet or socket", t => {
  for (const args of [
    ["--duration", "0"], ["--duration", "-1"], ["--duration", "NaN"],
    ["--duration", "1.5"], ["--duration", "1second"],
    ["--duration", "1e3"], ["--duration", ""], ["--duration"],
  ]) {
    // Early close avoids a five-minute wait if the base silently uses its default.
    const { result, output, marker } = run(t, args, true);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.match(result.stderr, /duration/i);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(output), false);
  }
});

test("default, minimum and largest timer-safe durations retain exact metadata", t => {
  for (const [args, seconds] of [
    [[], 300], [["--duration", "1"], 1], [["--duration", "2147483"], 2147483],
  ]) {
    const { result, output, marker } = run(t, args, true);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(marker), true);
    assert.doesNotMatch(result.stderr, /TimeoutOverflowWarning/);
    const summary = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
    assert.equal(summary.duration_seconds, seconds);
    assert.equal(summary.total_events, 0);
  }
});
