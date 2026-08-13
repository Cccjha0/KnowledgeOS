const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

class Plugin {
  constructor() {
    this.app = {
      vault: { adapter: { basePath: "mock-vault" }, on: () => ({}) },
      workspace: { on: () => ({}), onLayoutReady: () => {}, getLeavesOfType: () => [] },
    };
    this.registeredViews = [];
  }
  async loadData() { return {}; }
  async saveData() {}
  registerView(type, factory) { this.registeredViews.push([type, factory]); }
  addRibbonIcon() {}
  addCommand() {}
  registerEvent() {}
  addSettingTab() {}
  registerInterval(intervalId) { clearInterval(intervalId); }
}

class ItemView { constructor(leaf) { this.leaf = leaf; } }
class Modal { constructor(app) { this.app = app; } }
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
class Setting {}
class Notice {}

test("the bundled plugin completes its registration phase without unresolved dependencies", async () => {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "obsidian") return { ItemView, Modal, Notice, Plugin, PluginSettingTab, Setting, setIcon: () => {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const PluginClass = require("../dist/main.js");
    const plugin = new PluginClass();
    await plugin.onload();
    assert.deepEqual(plugin.registeredViews.map(([type]) => type).sort(), [
      "knowledgeos-inbox", "knowledgeos-reviews", "knowledgeos-system", "knowledgeos-today",
    ]);
    plugin.onunload();
  } finally {
    Module._load = originalLoad;
  }
});
