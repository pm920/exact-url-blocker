// What the blocker enforces, and the only place that decides it.
//
// Every entry is locked on: the pages offer no switch and no delete for it, and
// because every page and the background read state through enforce(), an off
// flag or enabled:false left in storage has no effect either.
//
// What gets blocked comes from the one-time setup (setup.html): groups that are
// blocked for good, and groups that open only inside the time windows chosen
// there. Setup can run once; after that it is sealed and nothing it wrote can be
// loosened from the pages. Sites added later through the popup or the options
// page are blocked for good.

import { parseEntry, buildRegex, entryLabel } from "./rules.js";

// Ready-made groups for the setup page. Where a service has a second address
// that plays the same content on a desktop browser, it is part of the group,
// because leaving it out would be the obvious way around the block.
//
// Google's games all load as a page or as a frame on top of the search results,
// from one of three places (checked 2026-10-06 by starting them from a search):
//   google.com/fbx?fbx=...          Snake, Minesweeper, Block Breaker, Memory
//   google.com/logos/....html       Solitaire, PAC-MAN and the other doodle games
//   dailygames.discover.google.com  Color Tiles, Tic-Tac-Go
// Search itself is untouched.
export const PRESETS = [
  { name: "Instagram", urls: ["www.instagram.com"] },
  { name: "TikTok", urls: ["www.tiktok.com"] },
  { name: "YouTube", urls: ["www.youtube.com", "m.youtube.com", "www.youtube-nocookie.com"] },
  { name: "X", urls: ["x.com"] },
  { name: "Reddit", urls: ["www.reddit.com", "old.reddit.com"] },
  { name: "Facebook", urls: ["www.facebook.com", "m.facebook.com"] },
  { name: "LinkedIn", urls: ["www.linkedin.com"] },
  { name: "Snapchat", urls: ["www.snapchat.com"] },
  { name: "Netflix", urls: ["www.netflix.com"] },
  { name: "Twitch", urls: ["www.twitch.tv"] },
  {
    name: "Google games",
    note: "Games like Snake, Minesweeper, etc.",
    urls: ["www.google.com/fbx", "www.google.com/logos", "dailygames.discover.google.com"]
  }
];

// Never blocked through the setup, the popup or the options page, whatever
// storage says: a misclick on Google would take search, sign-in and every
// reCAPTCHA with it, with no way back in the UI. This is also how a site added
// by mistake comes off again: add its host here and reload the extension.
// The Google games preset is deliberate and not affected.
const NEVER_BLOCK = ["google.com"];

export function isNeverBlocked(entry) {
  return NEVER_BLOCK.includes(entry.host.replace(/^www\./, ""));
}

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Whether we are inside one of the windows ([from, to), may wrap past midnight). */
export function isOpen(windows, now = new Date()) {
  const t = now.getHours() * 60 + now.getMinutes();
  return (windows || []).some(([a, b]) => {
    const from = toMinutes(a);
    const to = toMinutes(b);
    return from <= to ? t >= from && t < to : t >= from || t < to;
  });
}

/** The next full minute at which isOpen() flips, or null when it never does. */
export function nextChange(windows, now = new Date()) {
  const open = isOpen(windows, now);
  const t = new Date(now);
  t.setSeconds(0, 0);
  for (let i = 0; i < 24 * 60; i++) {
    t.setMinutes(t.getMinutes() + 1);
    if (isOpen(windows, t) !== open) return t;
  }
  return null;
}

export function windowsText(windows) {
  return (windows || []).map(([from, to]) => `${from}-${to}`).join(" and ");
}

/**
 * The state every page and the background actually work with.
 *
 * Stored entries come first so their ids stay stable between reads; the setup
 * groups fill in what storage lacks. Entries that compile to the same rule
 * (youtube.com and www.youtube.com) collapse into one, and an entry that matches
 * a setup group belongs to that group, so a site on a schedule follows the clock
 * even when it was also added by hand.
 */
export function enforce(state, now = new Date()) {
  const setup = state.setup || null;
  const groups = setup ? setup.groups : [];
  const blockedNow = !isOpen(setup && setup.windows, now);

  const groupOf = new Map();
  const seeds = [];
  for (const g of groups) {
    for (const url of g.urls) {
      const e = parseEntry(url);
      if (!e) continue;
      groupOf.set(buildRegex(e, true), g);
      seeds.push(e);
    }
  }

  const stored = (state.entries || []).filter((e) => !isNeverBlocked(e));
  const seen = new Set();
  const entries = [];
  for (const e of [...stored, ...seeds]) {
    const rule = buildRegex(e, true);
    if (seen.has(rule)) continue;
    seen.add(rule);
    const g = groupOf.get(rule);
    const scheduled = !!g && g.mode === "scheduled";
    entries.push({ ...e, group: g ? g.name : undefined, scheduled, on: scheduled ? blockedNow : true });
  }
  return { ...state, enabled: true, wwwEquivalent: true, entries };
}

/** The list as the pages show it: one row per setup group, one per other entry. */
export function rows(state) {
  const out = [];
  const groups = new Set();
  for (const e of state.entries) {
    if (e.group) {
      if (groups.has(e.group)) continue;
      groups.add(e.group);
    }
    out.push({ label: e.group || entryLabel(e), scheduled: e.scheduled, on: e.on, entry: e });
  }
  return out;
}
