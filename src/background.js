import { getState, STORAGE_AREA } from "./store.js";
import { buildRegex, activeMatchers, matchEntry, entryLabel } from "./rules.js";
import { rows, nextChange } from "./policy.js";

// Chrome caps regex-based dynamic rules; past that, extra entries are ignored.
const MAX_REGEX_RULES = 1000;

// Last sync failure, surfaced on the badge and in the popup. Without this a
// failed updateDynamicRules looks exactly like a working extension that has
// quietly stopped blocking anything.
let lastError = null;

function blockedPageBase() {
  return `chrome-extension://${chrome.runtime.id}/blocked.html`;
}

function toRule(entry, index, wwwEquivalent) {
  return {
    id: index + 1,
    priority: 1,
    action: {
      type: "redirect",
      // \0 is the whole matched URL, so the block page knows what it stopped.
      redirect: { regexSubstitution: `${blockedPageBase()}?u=\\0` }
    },
    condition: {
      regexFilter: buildRegex(entry, wwwEquivalent),
      isUrlFilterCaseSensitive: false,
      resourceTypes: ["main_frame", "sub_frame"]
    }
  };
}

/** The regexes the network layer should be holding for the given state. */
function wantedFilters(state) {
  return state.entries
    .filter((e) => e.on !== false)
    .slice(0, MAX_REGEX_RULES)
    .map((e) => buildRegex(e, state.wwwEquivalent));
}

// Popup, options page and storage events can all ask for a sync at once.
// Serialize them: removeRuleIds is computed from a snapshot, so two overlapping
// updates would collide on rule ids.
let queue = Promise.resolve();

function syncRules() {
  const next = queue.then(doSync, doSync);
  queue = next.catch(() => {});
  return next;
}

async function doSync() {
  const state = await getState();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  // Chrome rejects the whole update when a single regex is too large (a pasted
  // URL with a long query string does it), which silently froze every rule
  // after it. Leave such entries out and say which.
  const addRules = [];
  const tooLarge = [];
  for (const e of state.entries.filter((e) => e.on !== false).slice(0, MAX_REGEX_RULES)) {
    const rule = toRule(e, addRules.length, state.wwwEquivalent);
    const { isSupported } = await chrome.declarativeNetRequest.isRegexSupported({
      regex: rule.condition.regexFilter,
      isCaseSensitive: false
    });
    if (isSupported) addRules.push(rule);
    else tooLarge.push(entryLabel(e));
  }

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    lastError = tooLarge.length ? `Too long to block: ${tooLarge.join(", ")}` : null;
  } catch (err) {
    lastError = String(err && err.message ? err.message : err);
    await updateBadge(state);
    throw err;
  }

  await updateBadge(state);
  return state;
}

async function updateBadge(state) {
  if (lastError) {
    await chrome.action.setBadgeBackgroundColor({ color: "#b45309" });
    await chrome.action.setBadgeText({ text: "!" });
    return;
  }
  const count = rows(state).filter((r) => r.on !== false).length;
  await chrome.action.setBadgeBackgroundColor({ color: "#c62b30" });
  await chrome.action.setBadgeText({ text: count ? String(count) : "" });
}

/**
 * What the popup asks for: does the network layer actually hold the rules the
 * list implies? A mismatch means blocking is off even though the UI looks fine.
 */
async function health() {
  await reconcile();
  const state = await getState();
  const want = wantedFilters(state);
  let have = [];
  try {
    have = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.condition.regexFilter);
  } catch (err) {
    return { error: String(err && err.message ? err.message : err), live: 0, expected: want.length };
  }
  return { error: lastError, live: have.length, expected: want.length };
}

/**
 * Self-heal on every service worker start. Dynamic rules survive restarts on
 * their own, so they can drift out of step with storage after a failed write
 * or a ruleset Chrome refused to load, and nothing used to reconcile them
 * until the next edit. Only writes when the two genuinely disagree.
 */
async function reconcile() {
  try {
    const live = async () =>
      (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.condition.regexFilter);
    const state = await getState();
    const want = wantedFilters(state);
    const have = await live();
    const same = want.length === have.length && want.every((w, i) => w === have[i]);
    if (same) {
      await updateBadge(state);
      return;
    }
    await syncRules();
    // Something just became blocked (a schedule window closed): close what is open.
    const now = await live();
    if (now.some((f) => !have.includes(f))) await reloadBlockedTabs(await getState());
  } catch (err) {
    lastError = String(err && err.message ? err.message : err);
  }
}

/**
 * Pages already open when they become blocked would otherwise stay usable until
 * reload: a rule just added, or a schedule window closing on a running video or
 * game. Frames count too, since Google's games run in one on top of the search.
 */
async function reloadBlockedTabs(state) {
  const matchers = activeMatchers(state);
  if (!matchers.length) return;
  const blocked = (url) => /^https?:/i.test(url || "") && matchers.some((m) => m.re.test(url));

  for (const tab of await chrome.tabs.query({})) {
    if (!tab.id || !/^https?:/i.test(tab.url || "")) continue;
    let urls = [tab.url];
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      if (frames) urls = frames.map((f) => f.url);
    } catch {
      // No webNavigation or a tab mid-close: the top URL is all there is.
    }
    if (urls.some(blocked)) chrome.tabs.reload(tab.id).catch(() => {});
  }
}

/**
 * Wake when the schedule flips and apply it. Re-armed on every service worker
 * start, because Chrome may drop alarms across a browser restart. Chrome fires
 * alarms at most every 30 s, so a window can close up to half a minute late;
 * enforceUrl and the popup use the clock directly in the meantime.
 */
async function armSchedule() {
  const state = await getState();
  const next = nextChange(state.setup && state.setup.windows);
  if (next) await chrome.alarms.create("schedule", { when: next.getTime() + 1000 });
}

/**
 * declarativeNetRequest only ever sees real network requests. Single page apps
 * change the path without making one, so a path rule like x.com/home never
 * matches when the app routes there from x.com itself: the only request was for
 * "/" and that does not match the rule. Enforce the same rules on client side
 * route changes, which is the only way a path rule holds on a site like X.
 */
async function enforceUrl(details) {
  if (details.frameId !== 0) return;
  const state = await getState();
  if (!matchEntry(state, details.url)) return;
  chrome.tabs
    .update(details.tabId, { url: `${blockedPageBase()}?u=${details.url}` })
    .catch(() => {});
}

// A fresh install, or an update from before setup existed, starts at the setup page.
chrome.runtime.onInstalled.addListener(async (details) => {
  syncRules();
  const state = await getState();
  if (details.reason === "install" || !state.setup) {
    chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") });
  }
});
chrome.runtime.onStartup.addListener(() => syncRules());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== STORAGE_AREA) return;
  syncRules();
  if (changes.setup && chrome.alarms) armSchedule();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "applyNow") {
    syncRules()
      .then((state) => reloadBlockedTabs(state))
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }
  if (msg && msg.type === "syncOnly") {
    syncRules()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }
  if (msg && msg.type === "health") {
    health().then(sendResponse);
    return true;
  }
  return false;
});

// pushState / replaceState, and the separate event for bare fragment changes.
// Registered last and guarded: a throw here would leave every listener above
// unregistered, which kills the whole extension silently.
if (chrome.webNavigation) {
  chrome.webNavigation.onHistoryStateUpdated.addListener(enforceUrl);
  chrome.webNavigation.onReferenceFragmentUpdated.addListener(enforceUrl);
} else {
  lastError = "webNavigation permission missing; path rules will not hold on single-page apps.";
}

// Same reasoning: guarded and last.
if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "schedule") reconcile().finally(armSchedule);
  });
  armSchedule();
} else {
  lastError = "alarms permission missing; the YouTube schedule will not switch on time.";
}

reconcile();
