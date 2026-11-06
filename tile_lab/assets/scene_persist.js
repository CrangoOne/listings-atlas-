/**
 * Phone picker scene persistence.
 *
 * Catalog levels are re-embedded whenever an agent publishes the picker, so a
 * merge can replace the base under your feet. Edits alone live as ops in
 * localStorage; this module also pins a full level JSON base so the scene you
 * were editing keeps working across those republishes.
 *
 * Keys:
 *   tilelab.ops.v1:<levelName>  → JSON array of edit groups (existing)
 *   tilelab.base.v1:<levelName> → pinned full level JSON (this module)
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ScenePersist = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var OPS_PREFIX = "tilelab.ops.v1:";
  var BASE_PREFIX = "tilelab.base.v1:";

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function opsKey(levelName) {
    return OPS_PREFIX + levelName;
  }

  function baseKey(levelName) {
    return BASE_PREFIX + levelName;
  }

  function loadOps(storage, levelName) {
    try {
      var raw = storage.getItem(opsKey(levelName));
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }

  function saveOps(storage, levelName, groups) {
    storage.setItem(opsKey(levelName), JSON.stringify(groups || []));
  }

  function loadBase(storage, levelName) {
    try {
      var raw = storage.getItem(baseKey(levelName));
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && parsed.objects ? parsed : null;
    } catch (err) {
      return null;
    }
  }

  function saveBase(storage, levelName, level) {
    if (!level) {
      storage.removeItem(baseKey(levelName));
      return;
    }
    var pinned = clone(level);
    pinned.name = levelName;
    storage.setItem(baseKey(levelName), JSON.stringify(pinned));
  }

  function clearBase(storage, levelName) {
    storage.removeItem(baseKey(levelName));
  }

  function clearScene(storage, levelName) {
    storage.removeItem(opsKey(levelName));
    storage.removeItem(baseKey(levelName));
  }

  /** Prefer the pinned base; otherwise the published catalog level. */
  function resolveBase(storage, levelName, catalogLevels) {
    var pinned = loadBase(storage, levelName);
    if (pinned) return pinned;
    return catalogLevels[levelName];
  }

  /**
   * On the first edit of a catalog level, freeze today's catalog copy so a
   * later publish cannot rewrite the foundation under existing ops.
   */
  function pinCatalogIfNeeded(storage, levelName, catalogLevel) {
    if (loadBase(storage, levelName) || !catalogLevel) return false;
    saveBase(storage, levelName, catalogLevel);
    return true;
  }

  /**
   * Fold the resolved scene into the pinned base and clear ops. Use this when
   * the edit list gets long, or before you walk away mid-layout.
   */
  function bakeScene(storage, levelName, resolvedLevel) {
    if (!resolvedLevel) throw new Error("bakeScene needs a resolved level");
    saveBase(storage, levelName, resolvedLevel);
    saveOps(storage, levelName, []);
    return clone(loadBase(storage, levelName));
  }

  /** Drop the pin and the ops so the picker shows the latest catalog again. */
  function resetToCatalog(storage, levelName) {
    clearScene(storage, levelName);
  }

  function hasPinnedBase(storage, levelName) {
    return !!loadBase(storage, levelName);
  }

  function levelLabel(levelName, storage) {
    return hasPinnedBase(storage, levelName) ? levelName + " (saved)" : levelName;
  }

  return {
    OPS_PREFIX: OPS_PREFIX,
    BASE_PREFIX: BASE_PREFIX,
    opsKey: opsKey,
    baseKey: baseKey,
    clone: clone,
    loadOps: loadOps,
    saveOps: saveOps,
    loadBase: loadBase,
    saveBase: saveBase,
    clearBase: clearBase,
    clearScene: clearScene,
    resolveBase: resolveBase,
    pinCatalogIfNeeded: pinCatalogIfNeeded,
    bakeScene: bakeScene,
    resetToCatalog: resetToCatalog,
    hasPinnedBase: hasPinnedBase,
    levelLabel: levelLabel
  };
});
