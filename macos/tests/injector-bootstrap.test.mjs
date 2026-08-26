import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  applyThemeUpdateToSession,
  cleanupExcludedSurface,
  earlyPayloadFor,
  isEligibleAppTargetUrl,
  operationPresentationAllows,
  rendererVisibilityAllowsRotation,
} from "../scripts/injector.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const injectorPath = path.resolve(here, "../scripts/injector.mjs");
const source = await fs.readFile(injectorPath, "utf8");
const commonSource = await fs.readFile(path.resolve(here, "../scripts/common-macos.sh"), "utf8");
const loadImageSource = await fs.readFile(
  path.resolve(here, "../scripts/load-image-theme-macos.sh"),
  "utf8",
);
const rotateSource = await fs.readFile(
  path.resolve(here, "../scripts/rotate-images-macos.sh"),
  "utf8",
);
const shellSelector = 'main:is(.main-surface, [data-app-shell-main-surface], [class*="_MainContentSurface_"])';

function createFixture() {
  const domReady = [];
  const timers = new Map();
  const intervals = new Map();
  let nextTimer = 1;
  let nextInterval = 1;
  const markers = {
    shell: false,
    sidebar: false,
    main: false,
    settingsPanel: false,
    settings: false,
    genericInput: false,
    branding: false,
  };
  let root = {};
  const context = {
    window: { installs: [] },
    location: { protocol: "app:" },
    document: {
      get documentElement() { return root; },
      addEventListener(type, callback) { if (type === "DOMContentLoaded") domReady.push(callback); },
      querySelector(selector) {
        if (selector === shellSelector) return markers.shell ? {} : null;
        if (selector === "aside.app-shell-left-panel") return markers.sidebar ? {} : null;
        if (selector === "[role=\"main\"]") return markers.main ? {} : null;
        if (selector === "main, [role=\"main\"]") return markers.main ? {} : null;
        if (selector === '[data-settings-panel-slug="general-settings"]') {
          return markers.settingsPanel ? {} : null;
        }
        if (selector.includes("textarea") || selector.includes("contenteditable") || selector.includes("textbox")) {
          return markers.genericInput ? {} : null;
        }
        if (selector.includes("appearance-theme") || selector.includes("theme-preview")) {
          return markers.settings ? {} : null;
        }
        if (selector.includes("app-shell-header-context-menu-surface")) {
          return markers.branding ? {} : null;
        }
        return null;
      },
    },
    setTimeout(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback) {
      const id = nextInterval++;
      intervals.set(id, callback);
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
  };
  return {
    context,
    markers,
    brandAsCodex() { markers.branding = true; },
    makeNotReady() { root = null; },
    makeReady() { root = {}; },
    fireDomReady() { for (const callback of [...domReady]) callback(); },
    tick() { for (const callback of [...intervals.values()]) callback(); },
    observers: [],
  };
}

const guarded = createFixture();
vm.runInNewContext(earlyPayloadFor('window.installs.push("guarded")', "guarded"), guarded.context);
assert.deepEqual(guarded.context.window.installs, [], "Auxiliary app targets must remain untouched.");
assert.equal(guarded.observers.length, 0, "Early bootstrap must not install a broad MutationObserver.");
guarded.markers.shell = true;
guarded.tick();
assert.deepEqual(guarded.context.window.installs, [], "A shell without its sidebar is not sufficient for identity.");
guarded.markers.sidebar = true;
guarded.tick();
assert.deepEqual(guarded.context.window.installs, ["guarded"]);

const generic = createFixture();
vm.runInNewContext(earlyPayloadFor('window.installs.push("generic")', "generic"), generic.context);
generic.markers.main = true;
generic.markers.genericInput = true;
generic.tick();
assert.deepEqual(generic.context.window.installs, [],
  "An unbranded app:// page with generic main/input anchors must remain untouched.");
generic.brandAsCodex();
generic.tick();
assert.deepEqual(generic.context.window.installs, ["generic"],
  "A verified app:// Codex surface with generic main/input anchors must accept newer renderer shells.");

const settingsPanel = createFixture();
vm.runInNewContext(
  earlyPayloadFor('window.installs.push("settings-panel")', "settings-panel"),
  settingsPanel.context,
);
settingsPanel.markers.settingsPanel = true;
settingsPanel.tick();
assert.deepEqual(settingsPanel.context.window.installs, ["settings-panel"],
  "Codex 26.727 Settings must accept its stable general-settings panel without legacy appearance controls.");

const generations = createFixture();
generations.makeNotReady();
generations.markers.shell = true;
generations.markers.sidebar = true;
vm.runInNewContext(earlyPayloadFor('window.installs.push("old")', "old"), generations.context);
vm.runInNewContext(earlyPayloadFor('window.installs.push("new")', "new"), generations.context);
generations.makeReady();
generations.fireDomReady();
assert.deepEqual(
  generations.context.window.installs,
  ["new"],
  "A stale early script must yield to the newest watcher generation.",
);
assert.equal(generations.context.window.__CODEX_DREAM_SKIN_EARLY_APPLIED__, "new");

const updateCalls = [];
const updated = await applyThemeUpdateToSession({
  async send(method, params) {
    updateCalls.push({ method, params });
    if (method === "Runtime.evaluate") return { result: { objectId: "installer-1" } };
    if (method === "Runtime.callFunctionOn") return { result: { value: { installed: true } } };
    return {};
  },
}, {
  css: ".fixture { color: red; }",
  artDataUrl: "data:image/png;base64,THEME_UPDATE_MARKER",
  theme: { id: "updated" },
  revision: "updated-revision",
});
assert.equal(updated, true);
const updateCall = updateCalls.find(({ method }) => method === "Runtime.callFunctionOn");
assert.equal(updateCall.params.arguments[1].value, "data:image/png;base64,THEME_UPDATE_MARKER");
assert.equal(updateCall.params.arguments[3].value, "updated-revision");
assert.doesNotMatch(
  `${updateCall.params.functionDeclaration}\n${updateCalls[0].params.expression}`,
  /THEME_UPDATE_MARKER/,
  "Image bytes must travel as CDP arguments, never JavaScript source.",
);
assert.equal(updateCalls.at(-1).method, "Runtime.releaseObject");

assert.equal(operationPresentationAllows("all", "loading"), true);
assert.equal(operationPresentationAllows("errors-only", "loading"), false);
assert.equal(operationPresentationAllows("errors-only", "error"), true);
assert.equal(operationPresentationAllows("none", "error"), false);
assert.equal(isEligibleAppTargetUrl("app://-/index.html"), true);
assert.equal(
  isEligibleAppTargetUrl("app://-/index.html?initialRoute=%2Favatar-overlay"),
  false,
);
assert.equal(isEligibleAppTargetUrl("https://example.com/index.html"), false);
assert.equal(rendererVisibilityAllowsRotation("visible"), true);
assert.equal(rendererVisibilityAllowsRotation("hidden"), false);
assert.equal(rendererVisibilityAllowsRotation("prerender"), false);
assert.match(
  commonSource,
  /--operation-presentation "\$presentation"/,
  "Hot reapply must pass its presentation policy into the one-shot injector.",
);
assert.match(
  loadImageSource,
  /--operation-state-owner\) OPERATION_STATE_OWNER=/,
  "Image loads must support a caller-owned operation lifecycle.",
);
assert.ok(
  rotateSource.indexOf('write_operation_state applying "正在自动换图"') <
    rotateSource.indexOf('"$SCRIPT_DIR/load-image-theme-macos.sh" --from-library "$candidate"'),
  "Automatic rotation must publish one operation before trying candidate images.",
);
assert.match(rotateSource, /--operation-presentation none/);
assert.match(rotateSource, /--operation-state-owner caller/);
assert.match(rotateSource, /--check-visible/);
assert.ok(
  rotateSource.indexOf("ensure_node_runtime") < rotateSource.indexOf('"$NODE" "$INJECTOR" --check-visible'),
  "Rotation must initialize Node in the parent shell before checking renderer visibility.",
);
assert.ok(
  rotateSource.indexOf("! rotation_renderer_visible") <
    rotateSource.indexOf('write_operation_state applying "正在自动换图"'),
  "Automatic rotation must defer before publishing or mutating when the renderer is hidden.",
);
assert.match(
  rotateSource,
  /if \[ "\$candidate_status" -eq 2 \]; then[\s\S]*return 0/,
  "Renderer failures must stop the candidate loop instead of retrying every image.",
);
assert.match(
  source,
  /const refreshPayload = async \(\) => \{\s+await pruneInvalidSessions\(\);/,
  "Watcher must revalidate retained targets before transferring a new image.",
);

const earlySource = earlyPayloadFor("", "source-contract");
assert.doesNotMatch(earlySource, /MutationObserver|childList|subtree/,
  "Early bootstrap must not observe the entire renderer DOM.");
assert.doesNotMatch(earlySource, /document\.title|document\.body\?\.innerText|location\.href/,
  "The early bootstrap must not read page title, body text, or URL.");
assert.match(earlySource, /DOMContentLoaded/);
assert.match(earlySource, /setInterval\(install, 250\)/);
const identityProbeStart = source.indexOf("async function probeSession");
const identityProbeSource = source.slice(identityProbeStart, identityProbeStart + 1800);
assert.ok(identityProbeStart >= 0, "The live target probe must remain covered by the identity test.");
const probePrefix = "return session.evaluate(`";
const probePayloadStart = source.indexOf(probePrefix, identityProbeStart) + probePrefix.length;
const probePayloadEnd = source.indexOf("`);", probePayloadStart);
assert.ok(probePayloadStart >= probePrefix.length && probePayloadEnd > probePayloadStart,
  "The live identity expression must remain extractable for behavioral testing.");
const probeTemplate = source.slice(probePayloadStart, probePayloadEnd);
assert.doesNotMatch(probeTemplate, /`/, "The live identity expression must not contain nested template literals.");
const liveProbePayload = vm.runInNewContext(`\`${probeTemplate}\``, {
  selectorLiteral: (key) => JSON.stringify(`[selector-${key}]`),
  stableTestidLiteral: (key) => JSON.stringify(`[data-testid="${key}"]`),
});
const runLiveProbe = ({
  protocol = "app:", settingsPanel: hasSettingsPanel = false,
  genericMain = false, genericInput = false, branding = false,
  pathname = "/index.html", initialRoute = "",
} = {}) => vm.runInNewContext(liveProbePayload, {
  location: {
    protocol,
    pathname,
    search: initialRoute ? `?initialRoute=${encodeURIComponent(initialRoute)}` : "",
  },
  URLSearchParams,
  document: {
    querySelector(selector) {
      if (selector === "[selector-settings-panel]") return hasSettingsPanel ? {} : null;
      if (selector === 'main, [role="main"]') return genericMain ? {} : null;
      if (selector === 'textarea, [contenteditable="true"], [role="textbox"]') {
        return genericInput ? {} : null;
      }
      if (selector === '[data-testid="app-shell-header-context-menu-surface"]') {
        return branding ? {} : null;
      }
      return null;
    },
  },
});
assert.equal(runLiveProbe({ settingsPanel: true }).codex, true,
  "The live probe must accept the Codex 26.727 general Settings panel on app://.");
assert.equal(runLiveProbe({ protocol: "https:", settingsPanel: true }).codex, false,
  "The Settings marker must never identify a non-app target.");
assert.equal(runLiveProbe({ genericMain: true, genericInput: true }).codex, false,
  "The live probe must reject an unbranded generic app target.");
assert.equal(runLiveProbe({ genericMain: true, genericInput: true, branding: true }).codex, true,
  "The live probe may accept generic anchors only with the stable Codex branding marker.");
const avatarOverlayProbe = runLiveProbe({ settingsPanel: true, initialRoute: "/avatar-overlay" });
assert.equal(avatarOverlayProbe.excludedPetSurface, true);
assert.equal(avatarOverlayProbe.codex, false,
  "The avatar overlay must never be treated as the primary Codex renderer.");
const petCompositionProbe = runLiveProbe({
  settingsPanel: true, pathname: "/avatar-overlay-composition-surface.html",
});
assert.equal(petCompositionProbe.excludedPetSurface, true);
assert.equal(petCompositionProbe.codex, false,
  "Pet composition surfaces must stay outside the Dream Skin target set.");
const cleanupEvaluations = [];
assert.equal(await cleanupExcludedSurface({
  async evaluate(expression) { cleanupEvaluations.push(expression); return true; },
}), true, "Excluded Pet cleanup must remove and verify stale renderer state.");
assert.equal(cleanupEvaluations.length, 2);
assert.match(cleanupEvaluations[0], /__CODEX_DREAM_SKIN_DISABLED__/);
assert.match(cleanupEvaluations[1], /hasAttributes/);
assert.ok((source.match(/probe\?\.excludedPetSurface && !await cleanupExcludedSurface/g) || []).length >= 2,
  "One-shot and watcher discovery must both clean excluded Pet targets.");
assert.match(identityProbeSource, /selectorLiteral\("settings-panel"\)/,
  "The live probe must retain the current Settings structural marker.");
assert.match(identityProbeSource, /return Boolean\(main && input && branded\)/,
  "The live target probe must require branding together with both generic anchors.");
assert.match(identityProbeSource, /app-shell-header-context-menu-surface/,
  "The live target probe must use a structural Codex branding marker.");
assert.doesNotMatch(identityProbeSource, /document\.title|document\.body\?\.innerText|location\.href/,
  "The live target probe must not read page title, body text, or URL.");
assert.doesNotMatch(identityProbeSource, /\(main && input\) \|\||\(main && branded\) \|\||\(input && branded\)/);
const discoveryStart = source.indexOf("record.earlyScriptId = await registerEarly");
const probeStart = source.indexOf("const probe = await waitForCodexProbe", discoveryStart);
assert.ok(discoveryStart >= 0 && probeStart > discoveryStart, "Early registration must happen before full shell probing.");
assert.match(
  source,
  /finally\s*\{[\s\S]*Promise\.all\(\[\.\.\.sessions\.values\(\)\][\s\S]*removeEarly\(record\)/,
  "Watcher shutdown must unregister persistent Page scripts before closing CDP sessions.",
);
assert.match(
  source,
  /const earlyApplied = await session\.evaluate\([\s\S]*if \(!earlyApplied\) \{[\s\S]*applyToSession/,
  "The watcher must not run the full payload twice after a successful early install.",
);
assert.match(
  source,
  /const suggestionLabelColorsMatch = visibleSuggestionLabels\.every\(/,
  "Live verification must reject visible home suggestion labels that diverge from the themed card color.",
);
assert.match(source, /visibleSuggestionLabels\.length >= result\.visibleCardCount/);
assert.match(source, /result\.suggestionLabelColorsMatch/);

console.log("PASS: early injection is L0-ready, generation-safe, and removed on shutdown.");
