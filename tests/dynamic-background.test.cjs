const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "../ui/dynamic-background.js"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const pixels = (rgb) => new Uint8ClampedArray(Array.from({ length: 1024 }, () => [...rgb, 255]).flat());

function setup(theme = "dynamic", reduced = true) {
  const tasks = new Map();
  let id = 0;
  const later = (fn, delay) => { tasks.set(++id, { fn, delay }); return id; };
  const cancel = (id) => tasks.delete(id);
  const classes = () => {
    const values = new Set();
    return {
      add: (value) => values.add(value), remove: (value) => values.delete(value),
      contains: (value) => values.has(value),
      toggle(value, on) { on ? values.add(value) : values.delete(value); },
    };
  };
  const layer = () => ({ classList: classes(), style: { setProperty(key, value) { this[key] = value; } } });
  const layers = [layer(), layer()];
  layers[0].classList.add("is-visible");
  const backdrop = { children: layers, classList: classes() };
  const immersive = { classList: classes() };
  const root = { dataset: { theme } };
  const document = Object.assign(new EventTarget(), {
    hidden: false, documentElement: root,
    querySelector: (selector) => selector === ".dynamic-background" ? backdrop : immersive,
    createElement() {
      return { getContext: () => ({
        drawImage() { if (app.tainted) throw new Error("SecurityError"); },
        getImageData: () => ({ data: app.pixels }),
      }) };
    },
  });
  const media = Object.assign(new EventTarget(), { matches: reduced });
  const window = Object.assign(new EventTarget(), {
    matchMedia: () => media, requestIdleCallback: (fn) => later(fn, "idle"), cancelIdleCallback: cancel,
  });
  const observers = [];
  const images = [];
  const context = vm.createContext({
    document, window, setTimeout: later, clearTimeout: cancel,
    Image: class { constructor() { images.push(this); } decode() { return Promise.resolve(); } },
    MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} },
  });
  const app = {
    root, document, media, images, layers, tasks, immersive, backdrop,
    pixels: pixels([230, 60, 35]), tainted: false,
    run(delay) {
      for (const [id, task] of [...tasks]) {
        if (task.delay === delay) { tasks.delete(id); task.fn(); }
      }
    },
    track(url, hasCurrent = true) {
      window.dispatchEvent(Object.assign(new Event("bilibili-music-trackchange"), { detail: { thumbnailUrl: url, hasCurrent } }));
    },
    available() { observers.forEach((fn) => fn()); },
    palette() { return layers.find((layer) => layer.classList.contains("is-visible")).style; },
    extract(data) { return plain(context.extractDynamicPalette(data)); },
  };
  vm.runInContext(source, context);
  return app;
}

test("palette keeps distinct dominant colors, bounds brightness and handles empty artwork", () => {
  const app = setup();
  const mixed = new Uint8ClampedArray([...pixels([230, 40, 20]), ...pixels([20, 220, 40]), ...pixels([30, 50, 230])]);
  const result = app.extract(mixed);
  assert.equal(new Set(result).size, 3);
  for (const color of result) {
    const channels = color.match(/\d+/g).map(Number);
    assert.ok(channels.every((value) => value >= 8 && value <= 110));
    assert.ok(Math.max(...channels) - Math.min(...channels) >= 60);
    assert.ok(Math.max(...channels) - Math.min(...channels) <= 82);
  }
  assert.deepEqual(app.extract(new Uint8ClampedArray(4096)), app.extract(pixels([255, 255, 255])));
});

test("successful extraction is deferred; CORS, image failure, timeout and empty queue silently use defaults", async () => {
  const app = setup();
  const defaultColor = app.palette()["--dynamic-color-1"];
  app.track("cover-a");
  const image = app.images.at(-1);
  assert.equal(image.crossOrigin, "anonymous");
  assert.equal(image.referrerPolicy, "no-referrer");
  await image.onload();
  assert.equal(app.palette()["--dynamic-color-1"], defaultColor);
  app.run("idle");
  assert.equal(app.palette()["--dynamic-color-1"], app.extract(app.pixels)[0]);
  app.track("tainted");
  app.tainted = true;
  await app.images.at(-1).onload();
  app.run("idle");
  assert.equal(app.palette()["--dynamic-color-1"], defaultColor);
  app.track("failed");
  app.images.at(-1).onerror();
  assert.equal(app.palette()["--dynamic-color-1"], defaultColor);
  app.track("decode-failed");
  app.images.at(-1).decode = () => Promise.reject(new Error("decode failed"));
  await app.images.at(-1).onload();
  assert.equal(app.palette()["--dynamic-color-1"], defaultColor);
  app.track("timeout");
  let decoded;
  app.images.at(-1).decode = () => new Promise((resolve) => { decoded = resolve; });
  const lateDecode = app.images.at(-1).onload();
  app.run(8000);
  decoded();
  await lateDecode;
  assert.equal(app.tasks.size, 0);
  assert.equal(app.palette()["--dynamic-color-1"], defaultColor);
  app.track("unused", false);
  assert.equal(app.palette()["--dynamic-color-1"], defaultColor);
});

test("late artwork cannot win; other themes, hidden windows and immersive view do no sampling", async () => {
  const app = setup("dark");
  app.track("old");
  assert.equal(app.images.length, 0);
  app.root.dataset.theme = "dynamic";
  app.available();
  const lateLoad = app.images.at(-1).onload;
  app.track("new");
  await app.images.at(-1).onload();
  app.run("idle");
  const current = app.palette()["--dynamic-color-1"];
  await lateLoad();
  assert.equal(app.tasks.size, 0);
  assert.equal(app.palette()["--dynamic-color-1"], current);
  app.immersive.classList.add("is-open");
  app.available();
  const count = app.images.length;
  app.track("while-immersive");
  assert.equal(app.images.length, count);
  assert.ok(app.backdrop.classList.contains("is-paused"));
  app.immersive.classList.remove("is-open");
  app.document.hidden = true;
  app.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(app.images.length, count);
  app.document.hidden = false;
  app.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(app.images.length, count + 1);
});

test("crossfade keeps only latest pending palette; reduced motion removes fade work", async () => {
  const app = setup("dynamic", false);
  app.run(2500);
  app.track("red");
  await app.images.at(-1).onload();
  app.run("idle");
  app.track("green");
  app.pixels = pixels([30, 200, 50]);
  await app.images.at(-1).onload();
  app.run("idle");
  app.track("blue");
  app.pixels = pixels([30, 40, 210]);
  await app.images.at(-1).onload();
  app.run("idle");
  app.run(2500);
  assert.equal(app.palette()["--dynamic-color-1"], app.extract(app.pixels)[0]);
  app.media.matches = true;
  app.media.dispatchEvent(new Event("change"));
  assert.equal(app.tasks.size, 0);
});

test("dynamic texture stays fixed and hidden while image controls retain their settings", () => {
  const appearance = readFileSync(path.join(__dirname, "../ui/appearance.js"), "utf8");
  const code = appearance.slice(appearance.indexOf("const BACKGROUND_PATH_KEY"), appearance.indexOf("const root ="))
    + appearance.slice(appearance.indexOf("function clampNumber("), appearance.indexOf("function streamSourceLabel("))
    + appearance.slice(appearance.indexOf("function applyTheme("), appearance.indexOf("function applyBackground("));
  const stored = new Map();
  const reads = [];
  function load() {
    const root = { dataset: {}, style: {
      setProperty(key, value) { this[key] = value; },
      removeProperty(key) { delete this[key]; },
    } };
    const imageOnlyGroups = ["image-settings", "texture-settings"].map((id) => ({
      id, classList: { toggle(name, disabled) { this.disabled = disabled; } },
    }));
    const context = vm.createContext({
      root, themeOptions: [], imageOnlyGroups,
      glassBlurSlider: {}, glassBlurValue: {}, panelAlphaSlider: {}, panelAlphaValue: {},
      contentAlphaSlider: {}, contentAlphaValue: {}, backgroundDimSlider: {}, backgroundDimValue: {},
      localStorage: {
        getItem(key) { reads.push(key); return stored.get(key) ?? null; },
        setItem: (key, value) => stored.set(key, value),
      },
    });
    vm.runInContext(code, context);
    return context;
  }
  const context = load();
  const values = (app) => [app.glassBlurSlider.value, app.panelAlphaSlider.value, app.contentAlphaSlider.value, app.backgroundDimSlider.value];
  context.applyTheme("image", false);
  assert.deepEqual(values(context), ["40", "72", "0", "90"]);
  assert.equal(context.panelAlphaSlider.min, "20");
  assert.equal(context.backgroundDimSlider.min, "40");
  assert.ok(context.imageOnlyGroups.every((group) => !group.classList.disabled));
  context.setGlassBlur(53);
  context.setPanelAlpha(25);
  context.setContentAlpha(35);
  context.setBackgroundDim(45);
  const legacySettings = [...stored];
  for (const key of ["glass-blur", "panel-alpha", "content-alpha", "background-dim"]) {
    stored.set(`bilibili-music.${key}.dynamic`, "99");
  }
  const allSettings = [...stored];
  reads.length = 0;
  context.applyTheme("dynamic", false);
  assert.deepEqual(reads, []);
  assert.deepEqual([...stored], allSettings);
  assert.ok(context.imageOnlyGroups.every((group) => group.classList.disabled));
  const fixedValues = { "--glass-blur": "0px", "--panel-alpha": "0.2", "--background-dim": "0", "--content-panel-alpha": "0" };
  const css = readFileSync(path.join(__dirname, "../ui/styles.css"), "utf8");
  const dynamicRule = css.match(/:root\[data-theme="dynamic"\] \{([^}]+)\}/)[1];
  for (const [property, value] of Object.entries(fixedValues)) {
    assert.equal(context.root.style[property], undefined);
    assert.equal(dynamicRule.match(new RegExp(`${property}:\\s*([^;]+);`))[1], value);
  }
  assert.ok(dynamicRule.includes("clamp(0, calc((0.72 - var(--panel-alpha)) * 1.5), 0.78)"));
  assert.ok(dynamicRule.includes("text-shadow: 0 1px 2px rgba(0, 0, 0, var(--dynamic-text-shadow-alpha))"));
  assert.equal(Math.min(0.78, Math.max(0, (0.72 - Number(fixedValues["--panel-alpha"])) * 1.5)), 0.78);
  for (const [key, value] of legacySettings) assert.equal(stored.get(key), value);
  context.applyTheme("image", false);
  assert.deepEqual(values(context), ["53", "25", "35", "45"]);
  assert.equal(context.panelAlphaSlider.min, "20");
  assert.equal(context.backgroundDimSlider.min, "40");

  const restarted = load();
  reads.length = 0;
  restarted.applyTheme("dynamic", false);
  assert.deepEqual(reads, []);
  for (const property of Object.keys(fixedValues)) assert.equal(restarted.root.style[property], undefined);
  for (const key of ["glass-blur", "panel-alpha", "content-alpha", "background-dim"]) {
    stored.set(`bilibili-music.${key}.dynamic`, "invalid");
  }
  restarted.applyTheme("dynamic", false);
  assert.deepEqual(reads, []);
  restarted.applyTheme("image", false);
  assert.deepEqual(values(restarted), ["53", "25", "35", "45"]);
  for (const theme of ["dark", "light", "image", "dynamic", "unknown", null]) {
    context.applyTheme(theme);
    assert.equal(context.root.dataset.theme, ["dark", "light", "image", "dynamic"].includes(theme) ? theme : "dark");
    assert.equal(stored.get("bilibili-music.theme"), context.root.dataset.theme);
    if (theme !== "image") {
      assert.ok(context.imageOnlyGroups.every((group) => group.classList.disabled));
    }
  }
});
