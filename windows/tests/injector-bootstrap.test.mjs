import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { applyThemeUpdateToSession, earlyPayloadFor } from "../scripts/injector.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const injectorPath = path.resolve(here, "../scripts/injector.mjs");
const source = await fs.readFile(injectorPath, "utf8");

function createFixture() {
  const observers = [];
  const timers = new Map();
  let nextTimer = 1;
  const markers = { shell: false, sidebar: false };
  const context = {
    window: { installs: [] },
    document: {
      documentElement: {},
      body: {},
      querySelector(selector) {
        if (selector === "main.main-surface") return markers.shell ? {} : null;
        if (selector === "aside.app-shell-left-panel") return markers.sidebar ? {} : null;
        return null;
      },
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        this.connected = true;
        observers.push(this);
      }
      observe() {}
      disconnect() { this.connected = false; }
    },
    setTimeout(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  return { context, markers, observers };
}

const guarded = createFixture();
vm.runInNewContext(earlyPayloadFor('window.installs.push("guarded")', "guarded"), guarded.context);
assert.deepEqual(guarded.context.window.installs, [], "Auxiliary app targets must remain untouched.");
guarded.markers.shell = true;
guarded.observers[0].callback([]);
assert.deepEqual(guarded.context.window.installs, [], "A main surface without the Codex sidebar is not sufficient.");
guarded.markers.sidebar = true;
guarded.observers[0].callback([]);
assert.deepEqual(guarded.context.window.installs, ["guarded"], "The guarded payload should install once the shell is complete.");

const generations = createFixture();
vm.runInNewContext(earlyPayloadFor('window.installs.push("old")', "old"), generations.context);
vm.runInNewContext(earlyPayloadFor('window.installs.push("new")', "new"), generations.context);
generations.markers.shell = true;
generations.markers.sidebar = true;
for (const observer of generations.observers) observer.callback([]);
assert.deepEqual(
  generations.context.window.installs,
  ["new"],
  "A stale early script must yield to the newest watcher generation.",
);
assert.equal(generations.context.window.__CODEX_DREAM_SKIN_EARLY_APPLIED__, "new");

const artDataUrl = "data:image/png;base64,THEME_UPDATE_MARKER";
const calls = [];
const updated = await applyThemeUpdateToSession({
  async send(method, params, timeoutMs) {
    calls.push({ method, params, timeoutMs });
    if (method === "Runtime.evaluate") return { result: { objectId: "installer-1" } };
    if (method === "Runtime.callFunctionOn") return { result: { value: { installed: true } } };
    return {};
  },
}, {
  css: ".fixture { color: red; }",
  artDataUrl,
  theme: { id: "updated" },
});
assert.equal(updated, true);
const updateCall = calls.find(({ method }) => method === "Runtime.callFunctionOn");
assert.equal(updateCall.params.arguments[1].value, artDataUrl);
assert.doesNotMatch(
  `${updateCall.params.functionDeclaration}\n${calls[0].params.expression}`,
  /THEME_UPDATE_MARKER/,
  "Image bytes must travel as call arguments, never as JavaScript source.",
);
assert.equal(updateCall.timeoutMs, 30000);
assert.equal(calls.at(-1).method, "Runtime.releaseObject");

const registrationStart = source.indexOf("earlyScriptId = await registerEarlyPayload");
const evaluateStart = source.indexOf("await session.evaluate(earlyPayloadFor", registrationStart);
const probeStart = source.indexOf("const probe = await waitForCodexProbe", registrationStart);
assert.ok(registrationStart >= 0 && evaluateStart > registrationStart && probeStart > evaluateStart,
  "New targets must register and run the early payload before full shell probing.");
assert.match(source, /lightweightUpdate &&\s+await applyThemeUpdateToSession/,
  "Theme-only refreshes must use the lightweight renderer call path.");
assert.match(source, /attachLoadReinject\(target\.id, target, session\)/,
  "Full document loads must restore the latest theme after the stable early script runs.");
assert.match(source, /Page\.removeScriptToEvaluateOnNewDocument/,
  "Watcher shutdown and static refreshes must unregister persistent Page scripts.");

console.log("PASS: Windows early injection is guarded and theme refreshes keep image bytes out of JavaScript source.");
