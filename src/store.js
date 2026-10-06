import { enforce } from "./policy.js";

// storage.local, not storage.sync: sync caps a single item at 8 KB, which the
// entry array hits at roughly 60 rules and then fails the write silently.
// Portability between machines is covered by export/import on the options page.
const AREA = "local";

export const DEFAULTS = {
  enabled: true,
  wwwEquivalent: true,
  entries: []
};

/** Always the enforced view, see policy.js: nothing on the list can be switched off. */
export async function getState() {
  const stored = await chrome.storage[AREA].get(DEFAULTS);
  return enforce({ ...DEFAULTS, ...stored });
}

export async function setState(patch) {
  await chrome.storage[AREA].set(patch);
}

/**
 * Push the current rules to the network layer and reload affected open tabs.
 * Returns {ok, error} instead of swallowing: a failure here means nothing is
 * being blocked, which is worth showing rather than hiding.
 */
export async function applyNow() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "applyNow" });
    return res || { ok: false, error: "No response from the background worker." };
  } catch (err) {
    // Service worker unreachable; storage.onChanged still triggers the sync.
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/** Does the network layer actually hold the rules the list implies? */
export async function getHealth() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "health" });
    return res || { error: "No response from the background worker.", live: 0, expected: 0 };
  } catch (err) {
    return { error: String(err && err.message ? err.message : err), live: 0, expected: 0 };
  }
}

export const STORAGE_AREA = AREA;
