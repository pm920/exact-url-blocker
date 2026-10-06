import { getState, setState, applyNow } from "./store.js";
import { parseEntry, entryLabel, buildRegex } from "./rules.js";
import { rows, windowsText } from "./policy.js";

const el = (id) => document.getElementById(id);
let state = null;

async function save(patch) {
  await setState(patch);
  await applyNow();
  await render();
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

    const box = document.createElement("div");
    box.className = "grow truncate";
    const label = document.createElement("div");
    label.className = "label truncate" + (row.entry.group ? " group" : "");
    label.textContent = row.label;
    const preview = document.createElement("div");
    preview.className = "preview truncate mono";
    preview.textContent = row.scheduled
      ? `Open ${windowsText(state.setup.windows)}, blocked otherwise`
      : buildRegex(row.entry, state.wwwEquivalent);
    preview.title = preview.textContent;
    box.append(label, preview);

    li.append(mark(row), box);
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
  const all = rows(state);
  const active = all.filter((r) => r.on !== false).length;
  el("list-title").textContent = `Blocked: ${active} active / ${all.length} total`;
  renderList();
}

el("bulk-add").addEventListener("click", () => {
  const lines = el("bulk").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const known = new Set(state.entries.map(entryLabel));
  const added = [];
  const rejected = [];

  for (const line of lines) {
    const entry = parseEntry(line);
    if (!entry) {
      rejected.push(line);
      continue;
    }
    const key = entryLabel(entry);
    if (known.has(key)) continue;
    known.add(key);
    added.push(entry);
  }

  const parts = [];
  if (added.length) parts.push(`${added.length} added`);
  if (rejected.length) parts.push(`skipped: ${rejected.join(", ")}`);
  el("bulk-msg").textContent = parts.join(" · ") || "Nothing new.";

  if (added.length) {
    el("bulk").value = "";
    save({ entries: [...added, ...state.entries] });
  }
});

el("export").addEventListener("click", async () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "url-blocker-backup.json";
  a.click();
  URL.revokeObjectURL(url);
});

el("import").addEventListener("click", () => el("file").click());

el("file").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = Array.isArray(data) ? data : data.entries;
    if (!Array.isArray(incoming)) throw new Error("no entries array");

    const known = new Set(state.entries.map(entryLabel));
    const added = [];
    for (const raw of incoming) {
      const source =
        typeof raw === "string" ? raw : raw && typeof raw.host === "string" ? entryLabel(raw) : null;
      if (!source) continue;
      const entry = parseEntry(source);
      if (!entry) continue;
      const key = entryLabel(entry);
      if (known.has(key)) continue;
      known.add(key);
      if (typeof raw === "object" && raw.on === false) entry.on = false;
      added.push(entry);
    }
    el("io-msg").textContent = `Imported ${added.length} new entries.`;
    if (added.length) save({ entries: [...state.entries, ...added] });
  } catch (err) {
    el("io-msg").textContent = `Import failed: ${err.message}`;
  } finally {
    ev.target.value = "";
  }
});

await render();
