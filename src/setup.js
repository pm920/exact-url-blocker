import { getState, setState, applyNow } from "./store.js";
import { parseEntry, entryLabel, buildRegex } from "./rules.js";
import { PRESETS, isNeverBlocked, windowsText } from "./policy.js";

// The one-time setup. Everything is decided here, then sealed: once state.setup
// exists this page only shows what was locked.

const el = (id) => document.getElementById(id);
const ruleOf = (url) => buildRegex(parseEntry(url), true);

const picked = []; // { name, note?, urls, mode: "always" | "scheduled" }
let windows = [["20:00", "22:00"]];

function start() {
  // Whatever is on the list from before setup comes in as ordinary rows, so it
  // can be kept, put on time windows or dropped like anything else: a site that
  // belongs to a preset as that preset, anything else as its own row.
  const stored = new Map(state.entries.map((e) => [buildRegex(e, true), e]));
  for (const p of PRESETS) {
    const rules = p.urls.map(ruleOf);
    if (!rules.some((r) => stored.has(r))) continue;
    picked.push({ ...p, mode: "always" });
    rules.forEach((r) => stored.delete(r));
  }
  for (const e of stored.values()) picked.push({ name: entryLabel(e), urls: [entryLabel(e)], mode: "always" });
  render();
}

function render() {
  renderPresets();
  renderPicked();
  renderWindows();
  renderSummary();
}

// Only what is not picked yet: a picked preset is a row in the list below, and
// removing that row brings its chip back.
function renderPresets() {
  const box = el("presets");
  box.innerHTML = "";
  const left = PRESETS.filter((p) => !picked.some((x) => x.name === p.name));
  box.hidden = !left.length;
  for (const p of left) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = p.name;
    chip.title = p.note || p.urls.join(", ");
    chip.addEventListener("click", () => {
      picked.push({ ...p, mode: "always" });
      render();
    });
    box.append(chip);
  }
}

function renderPicked() {
  const list = el("picked");
  list.innerHTML = "";
  for (const item of picked) {
    const li = document.createElement("li");

    const text = document.createElement("div");
    text.className = "grow truncate";
    const name = document.createElement("div");
    name.className = "name truncate";
    name.textContent = item.name;
    const covers = document.createElement("div");
    covers.className = "covers truncate";
    covers.textContent = item.note || item.urls.join(" · ");
    text.append(name);
    if (covers.textContent !== item.name) text.append(covers);

    const seg = document.createElement("div");
    seg.className = "seg";
    for (const [mode, label] of [["always", "Always"], ["scheduled", "Time windows"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      if (item.mode === mode) b.className = "on";
      b.addEventListener("click", () => {
        item.mode = mode;
        render();
      });
      seg.append(b);
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost";
    del.textContent = "✕";
    del.title = "Remove";
    del.addEventListener("click", () => {
      picked.splice(picked.indexOf(item), 1);
      render();
    });

    li.append(text, seg, del);
    list.append(li);
  }
}

function renderWindows() {
  const box = el("windows");
  box.innerHTML = "";
  windows.forEach((w, i) => {
    const row = document.createElement("div");
    row.className = "window";
    const from = timeInput(w[0], (v) => (windows[i][0] = v));
    const to = timeInput(w[1], (v) => (windows[i][1] = v));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost";
    del.textContent = "✕";
    del.title = "Remove window";
    del.addEventListener("click", () => {
      windows.splice(i, 1);
      render();
    });
    const sep = document.createElement("span");
    sep.textContent = "to";
    row.append(from, sep, to, del);
    box.append(row);
  });
  el("when").classList.toggle("muted", !hasScheduled());
}

function timeInput(value, set) {
  const input = document.createElement("input");
  input.type = "time";
  input.value = value;
  input.addEventListener("change", () => {
    set(input.value);
    renderSummary();
  });
  return input;
}

el("add-window").addEventListener("click", () => {
  windows.push(["12:00", "13:00"]);
  render();
});

const hasScheduled = () => picked.some((p) => p.mode === "scheduled");
const validWindows = () => windows.filter(([a, b]) => /^\d\d:\d\d$/.test(a) && /^\d\d:\d\d$/.test(b) && a !== b);

/** Why the lock button is off, or null when it can go. */
function blocker() {
  if (!picked.length) return "Pick at least one site.";
  if (hasScheduled() && !validWindows().length) return "Add at least one time window.";
  if (!el("understand").checked) return "Tick the box above to confirm.";
  return null;
}

function renderSummary() {
  const why = blocker();
  el("lock").disabled = !!why;
  el("lock-hint").textContent = why && why !== "Tick the box above to confirm." ? why : "";
}

el("understand").addEventListener("change", renderSummary);

el("custom-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const input = el("custom-input");
  const hint = el("custom-hint");
  hint.classList.add("error");

  const entry = parseEntry(input.value);
  if (!entry) {
    hint.textContent = "That is not a usable web address.";
    return;
  }
  if (isNeverBlocked(entry)) {
    hint.textContent = "Google itself can't be blocked. For the games, pick Google games.";
    return;
  }
  const rule = buildRegex(entry, true);
  if (picked.some((p) => p.urls.some((u) => ruleOf(u) === rule))) {
    hint.textContent = "Already picked.";
    return;
  }
  const { isSupported } = await chrome.declarativeNetRequest.isRegexSupported({ regex: rule, isCaseSensitive: false });
  if (!isSupported) {
    hint.textContent = "Too long to block. Leave out the part after the ?.";
    return;
  }

  hint.classList.remove("error");
  hint.textContent = "";
  input.value = "";
  picked.push({ name: entryLabel(entry), urls: [entryLabel(entry)], mode: "always" });
  render();
});

el("lock").addEventListener("click", async () => {
  if (blocker()) return;
  const fresh = await getState();
  if (fresh.setup) return showDone(fresh.setup);

  const setup = {
    version: 1,
    sealedAt: new Date().toISOString(),
    windows: hasScheduled() ? validWindows() : [],
    groups: picked.map(({ name, note, urls, mode }) => ({ name, ...(note ? { note } : {}), urls, mode }))
  };
  const btn = el("lock");
  btn.disabled = true;
  btn.textContent = "Locking…";
  // The rows above are the whole list now, including whatever was on it before
  // setup, so the old entries are replaced rather than kept next to them.
  await setState({ setup, entries: [] });
  await applyNow();
  showDone(setup);
});

function showDone(setup) {
  el("steps").hidden = true;
  el("done").hidden = false;
  el("done-since").textContent = `Locked on ${new Date(setup.sealedAt).toLocaleString()}.`;
  const list = el("done-list");
  list.innerHTML = "";
  for (const g of setup.groups) {
    const li = document.createElement("li");
    const mark = document.createElement("span");
    mark.className = "lock";
    mark.textContent = g.mode === "scheduled" ? "🕒" : "🔒";
    const text = document.createElement("div");
    text.className = "grow";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = g.name;
    const covers = document.createElement("div");
    covers.className = "covers";
    covers.textContent = g.mode === "scheduled" ? `Open ${windowsText(setup.windows)}` : "Blocked for good";
    text.append(name, covers);
    li.append(mark, text);
    list.append(li);
  }
}

// Last, so every helper and listener above exists before the first render.
const state = await getState();
if (state.setup) showDone(state.setup);
else start();
