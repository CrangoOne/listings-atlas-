/* Cast checklist + Play control for the Tile Lab level picker.
 * Reads characters from DATA.characters (self-contained picker) or
 * window.__TILE_LAB_CHARACTERS__ / ./assets/characters.json (Pages shell).
 * Leaves pages_app.js untouched: listens on #levelSel and #cells.
 */
(function () {
  "use strict";

  const PLAY_HREF = "../play/index.html";

  function $(id) {
    return document.getElementById(id);
  }

  function levelName() {
    const sel = $("levelSel");
    return sel && sel.value ? String(sel.value) : "";
  }

  function encodeCast(cast) {
    return cast
      .map((e) => e.id + ":" + e.cell[0] + ":" + e.cell[1])
      .join(",");
  }

  function buildRequest(level, cast) {
    return {
      schema: 1,
      level: level,
      cast: cast.map((e) => ({ id: e.id, cell: [e.cell[0], e.cell[1]] })),
    };
  }

  function buildPlayUrl(level, cast) {
    // Spec form: ?level=tavern&cast=marker:0:2 (colons stay literal).
    let url = PLAY_HREF + "?level=" + encodeURIComponent(level);
    const castQ = encodeCast(cast);
    if (castQ) url += "&cast=" + castQ;
    return url;
  }

  async function loadCharacters() {
    if (typeof DATA !== "undefined" && DATA && DATA.characters) {
      return DATA.characters;
    }
    if (window.__TILE_LAB_CHARACTERS__) {
      return window.__TILE_LAB_CHARACTERS__;
    }
    const candidates = [
      "./assets/characters.json",
      "./characters.json",
      "../godot/levels/characters.json",
    ];
    for (const href of candidates) {
      try {
        const url = new URL(href, window.location.href);
        const resp = await fetch(url.href, { cache: "no-store" });
        if (resp.ok) return await resp.json();
      } catch (_err) {
        /* try next */
      }
    }
    return { schema: 1, characters: [] };
  }

  function ensureMount() {
    let mount = $("castPlay");
    if (mount) return mount;
    mount = document.createElement("section");
    mount.id = "castPlay";
    mount.innerHTML =
      '<h2>Cast</h2>' +
      '<div id="castList" class="row" role="group" aria-label="Cast"></div>' +
      '<div class="row" style="margin-top:8px">' +
      '<button id="playBtn" class="primary" type="button">Play</button>' +
      '<span id="castStatus" class="legend" role="status"></span>' +
      "</div>" +
      '<p class="legend">Tick a character to include it (default cell). Tap a floor cell to move the ticked character. Play opens the game view and copies play.json for desktop F5.</p>';

    const cellsSection =
      $("cellsWrap") && $("cellsWrap").closest("section");
    const tools = document.querySelector(".tools-scroll");
    if (tools) {
      const modeBlock = tools.querySelector(".workspace-controls");
      if (modeBlock) tools.insertBefore(mount, modeBlock.nextSibling);
      else tools.insertBefore(mount, tools.firstChild);
    } else if (cellsSection && cellsSection.parentNode) {
      cellsSection.parentNode.insertBefore(mount, cellsSection);
    } else {
      const header = document.querySelector("header");
      if (header && header.parentNode) {
        header.parentNode.insertBefore(mount, header.nextSibling);
      } else {
        document.body.appendChild(mount);
      }
    }
    return mount;
  }

  function say(msg, ok) {
    const el = $("castStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = ok === false ? "var(--bad, #ff7a6b)" : "var(--dim, #b39d86)";
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_err) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        return true;
      } catch (_err2) {
        return false;
      }
    }
  }

  function boot(catalog) {
    const characters = Array.isArray(catalog.characters)
      ? catalog.characters
      : [];
    ensureMount();
    const list = $("castList");
    const state = {
      /** @type {Record<string, {id:string, cell:number[], checked:boolean}>} */
      picks: {},
    };

    characters.forEach((ch) => {
      const id = String(ch.id || "");
      if (!id) return;
      const def = Array.isArray(ch.default_cell)
        ? [Number(ch.default_cell[0]), Number(ch.default_cell[1])]
        : [0, 0];
      state.picks[id] = { id: id, cell: def.slice(), checked: false };

      const label = document.createElement("label");
      label.className = "chip";
      label.style.cursor = "pointer";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = id;
      cb.setAttribute("data-cast-id", id);
      const text = document.createElement("span");
      text.innerHTML =
        "<b>" +
        (ch.label || id) +
        '</b> <span class="tag" data-cast-cell="' +
        id +
        '">[' +
        def[0] +
        ", " +
        def[1] +
        "]</span>";
      cb.addEventListener("change", () => {
        state.picks[id].checked = cb.checked;
        if (cb.checked) {
          state.picks[id].cell = def.slice();
          refreshCellLabels();
        }
      });
      label.append(cb, text);
      list.appendChild(label);
    });

    function refreshCellLabels() {
      for (const id of Object.keys(state.picks)) {
        const tag = document.querySelector('[data-cast-cell="' + id + '"]');
        if (!tag) continue;
        const cell = state.picks[id].cell;
        tag.textContent = "[" + cell[0] + ", " + cell[1] + "]";
      }
    }

    function selectedCast() {
      return Object.keys(state.picks)
        .filter((id) => state.picks[id].checked)
        .map((id) => ({
          id: id,
          cell: state.picks[id].cell.slice(),
        }));
    }

    function assignCell(x, y) {
      const ticked = Object.keys(state.picks).filter(
        (id) => state.picks[id].checked
      );
      if (!ticked.length) return;
      // One floor tap assigns that cell to every ticked character (usual case: one).
      for (const id of ticked) {
        state.picks[id].cell = [x, y];
      }
      refreshCellLabels();
      say(
        "Cast cell [" +
          x +
          ", " +
          y +
          "] → " +
          ticked.join(", ")
      );
    }

    const cells = $("cells");
    if (cells) {
      cells.addEventListener(
        "click",
        (ev) => {
          const btn = ev.target && ev.target.closest
            ? ev.target.closest("button[data-x][data-y]")
            : null;
          if (!btn) return;
          const x = Number(btn.dataset.x);
          const y = Number(btn.dataset.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          assignCell(x, y);
        },
        true
      );
    }

    const playBtn = $("playBtn");
    if (playBtn) {
      playBtn.addEventListener("click", async () => {
        const level = levelName();
        if (!level) {
          say("Pick a level first.", false);
          return;
        }
        const cast = selectedCast();
        const req = buildRequest(level, cast);
        const json = JSON.stringify(req, null, 2) + "\n";
        const url = buildPlayUrl(level, cast);
        const copied = await copyText(json);
        say(
          (copied
            ? "Copied play.json. "
            : "Could not copy. ") +
            "Opening " +
            url
        );
        window.open(url, "_blank", "noopener");
      });
    }

    window.__castPlay = {
      state: state,
      selectedCast: selectedCast,
      buildRequest: buildRequest,
      buildPlayUrl: buildPlayUrl,
      assignCell: assignCell,
    };
  }

  function start() {
    loadCharacters().then(boot).catch((err) => {
      console.error(err);
      boot({ schema: 1, characters: [] });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
