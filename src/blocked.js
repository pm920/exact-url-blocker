import { getState } from "./store.js";
import { entryLabel, matchEntry } from "./rules.js";
import { nextChange } from "./policy.js";

const el = (id) => document.getElementById(id);

// The rule appends the original URL verbatim after "?u=", so take the raw tail
// rather than parsing params: the target may contain its own & and = characters.
const query = location.search;
const target = query.startsWith("?u=") ? query.slice(3) : "";

if (window.top !== window.self) document.body.classList.add("embedded");

let pretty = target;
try {
  pretty = decodeURI(target);
} catch {
  /* keep raw */
}
el("url").textContent = pretty || "(unknown URL)";

const state = await getState();
const entry = target ? matchEntry(state, target) : null;
const opensAt = () => nextChange(state.setup.windows).toTimeString().slice(0, 5);
el("rule").textContent = !entry
  ? ""
  : entry.scheduled
    ? `${entry.group} opens again at ${opensAt()}.`
    : `Rule: ${entry.group || entryLabel(entry)}`;

el("back").addEventListener("click", () => {
  if (history.length > 1) history.back();
  else chrome.tabs.getCurrent().then((tab) => tab && chrome.tabs.update(tab.id, { url: "about:blank" }));
});

el("close").addEventListener("click", async () => {
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.remove(tab.id);
});
