import { getState, setState, applyNow, getHealth } from "./store.js";
import { parseEntry, entryLabel, matchEntry } from "./rules.js";
import { rows, windowsText } from "./policy.js";

const el = (id) => document.getElementById(id);
let state = null;
let currentUrl = "";

async function save(patch) {
  await setState(patch);
  await applyNow();
  await render();
}

async function loadCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentUrl = tab && tab.url ? tab.url : "";
}

function renderCurrent() {
  const hostEl = el("current-host");
  const noteEl = el("current-note");
  const btn = el("block-current");

  const entry = currentUrl ? parseEntry(currentUrl) : null;
  if (!entry) {
    hostEl.textContent = "No blockable page";
    noteEl.textContent = "Only http and https pages can be blocked.";
    btn.disabled = true;
    return;
  }

  hostEl.textContent = entry.host;
  const already = state.entries.find((e) => e.host === entry.host && !e.path && !e.search && !e.port);
  const blockedBy = matchEntry(state, currentUrl);

  if (already) {
    noteEl.textContent = "Already on the list.";
    btn.disabled = true;
  } else if (blockedBy) {
    noteEl.textContent = `Covered by ${entryLabel(blockedBy)}`;
    btn.disabled = true;
  } else {
    noteEl.textContent = "This host only, no subdomains.";
    btn.disabled = false;
  }
}

function renderList() {
  const list = el("list");
  list.innerHTML = "";

  if (!state.entries.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nothing blocked yet.";
    list.append(li);
    return;
  }

  for (const row of rows(state)) {
    const li = document.createElement("li");
    if (row.on === false) li.classList.add("off");

    const label = document.createElement("div");
    label.className = "grow label truncate" + (row.entry.group ? " group" : "");
    label.textContent = row.label;
    label.title = row.scheduled ? `${row.label}: open ${windowsText(state.setup.windows)}` : row.label;

    li.append(mark(row), label);
    list.append(li);
  }
}

/** Scheduled rows open on the clock, everything else stays blocked. See policy.js. */
function mark(row) {
  const m = document.createElement("span");
  m.className = "lock";
  m.textContent = row.scheduled ? "🕒" : "🔒";
  m.title = row.scheduled ? `Open ${windowsText(state.setup.windows)}, blocked otherwise` : "Permanently blocked";
  return m;
}

async function render() {
  state = await getState();
  el("setup-banner").hidden = !!state.setup;
  const all = rows(state);
  const active = all.filter((r) => r.on !== false).length;
  el("count").textContent = `${active} active / ${all.length} total`;
  renderCurrent();
  renderList();
  renderHealth();
}

/**
 * The list looking right is not proof that anything is blocked. Compare it with
 * the rules the network layer is actually holding and say so when they differ.
 */
async function renderHealth() {
  const warn = el("warn");
  const h = await getHealth();
  if (h && !h.error && h.live === h.expected) {
    warn.hidden = true;
    return;
  }
  warn.hidden = false;
  warn.textContent = h && h.error
    ? `Rules not applied: ${h.error}`
    : `Not blocking: ${h ? h.live : 0} live rules vs ${h ? h.expected : 0} expected. `
      + `Reload the extension on chrome://extensions.`;
}

el("block-current").addEventListener("click", () => {
  const parsed = currentUrl ? parseEntry(currentUrl) : null;
  if (!parsed) return;
  // Host only: the popup button blocks the site, not the page you happen to be on.
  const entry = parseEntry(parsed.host + (parsed.port ? ":" + parsed.port : ""));
  if (!entry || state.entries.some((e) => entryLabel(e) === entryLabel(entry))) return;
  save({ entries: [entry, ...state.entries] });
});

el("add-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const input = el("add-input");
  const entry = parseEntry(input.value);
  const hint = el("add-hint");

  if (!entry) {
    hint.textContent = "Not a usable http/https address.";
    return;
  }
  if (state.entries.some((e) => entryLabel(e) === entryLabel(entry))) {
    hint.textContent = "Already on the list.";
    return;
  }
  input.value = "";
  hint.textContent = "Permanent once added. Exact host only.";
  save({ entries: [entry, ...state.entries] });
});

el("setup-banner").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") });
});

el("open-options").addEventListener("click", (ev) => {
  ev.preventDefault();
  chrome.runtime.openOptionsPage();
});

await loadCurrentTab();
await render();
