import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const capture = fileURLToPath(new URL("./pumpportal-capture.mjs", import.meta.url));
const preload = `globalThis.WebSocket = class extends EventTarget {
  constructor() {
    super();
    setImmediate(() => {
      this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({
        txType: 'buy', mint: '11111111111111111111111111111111', solAmount: 1
      })}));
      this.close();
    });
  }
  send() {}
  close() { this.dispatchEvent(Object.assign(new Event('close'), {code: 1000})); }
};`;

function packet(t) {
  const root = mkdtempSync(join(tmpdir(), "pumpportal-manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "packet");
  // Generate actual packet bytes and the actual standalone Python verifier.
  // Only event acquisition is replaced; no network or real credential is used.
  const generated = spawnSync(process.execPath, ["--import",
    `data:text/javascript,${encodeURIComponent(preload)}`, capture,
    "--duration", "30", "--output", output], {
    env: { PUMPPORTAL_API_KEY: "offline-placeholder" }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(generated.status, 0, generated.stderr);
  const manifestPath = join(output, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const save = value => writeFileSync(manifestPath, JSON.stringify(value));
  const verify = () => spawnSync("python3", [join(output, "verify.py")], {
    encoding: "utf8", timeout: 5000,
  });
  return { output, manifest, save, verify };
}

test("a complete generated packet verifies; changed bytes fail", t => {
  const p = packet(t);
  const good = p.verify();
  assert.equal(good.status, 0, good.stderr);
  writeFileSync(join(p.output, "README.md"), "changed");
  assert.equal(p.verify().status, 1);
});

test("every required artifact must remain covered even when its file is present", t => {
  const p = packet(t);
  for (const name of ["events.json", "token-index.json", "summary.json", "README.md", "verify.py"]) {
    const incomplete = { ...p.manifest };
    delete incomplete[name];
    p.save(incomplete);
    const result = p.verify();
    assert.equal(result.status, 1, `${name}: ${result.stdout} ${result.stderr}`);
    assert.match(result.stdout, /missing required manifest entries/);
  }
});

test("losing an artifact and its manifest entry cannot produce a successful verification", t => {
  const p = packet(t);
  delete p.manifest["events.json"];
  p.save(p.manifest);
  unlinkSync(join(p.output, "events.json"));
  const result = p.verify();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /events.json/);
});

test("empty and non-object manifests fail explicitly", t => {
  const p = packet(t);
  for (const manifest of [{}, [], null]) {
    p.save(manifest);
    const result = p.verify();
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /FAIL:/);
    assert.doesNotMatch(result.stderr, /Traceback/);
  }
});
