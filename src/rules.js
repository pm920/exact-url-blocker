// Parsing and pattern building.
//
// Matching contract: an entry matches its own host EXACTLY. Subdomains are
// never implied. Blocking "example.com" leaves "mail.example.com" reachable;
// to block that too, add it as its own entry.
//
// The single exception is the "www." prefix, which every site treats as the
// same site and which most bare domains 301-redirect to. It is optional and
// controlled by the wwwEquivalent setting (on by default).

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
}

function hasWwwVariant(host) {
  // Only real domain names get a www. sibling. Not IPs, not bare hostnames.
  return host.includes(".") && !IPV4.test(host) && !host.startsWith("[");
}

/**
 * Turn free text into a stored entry, or null if it is not a usable http(s) target.
 * Accepts "example.com", "https://example.com/foo", "sub.example.com:8080/bar?x=1".
 */
export function parseEntry(input) {
  let raw = String(input == null ? "" : input).trim();
  if (!raw) return null;

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = "https://" + raw;

  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  const host = u.hostname.toLowerCase();
  if (!host) return null;

  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");

  return {
    id: crypto.randomUUID(),
    host,
    port: u.port || "",
    path,
    search: u.search || "",
    on: true,
    addedAt: new Date().toISOString()
  };
}

/** Human-readable form of an entry. Also used as the dedupe key. */
export function entryLabel(entry) {
  return entry.host + (entry.port ? ":" + entry.port : "") + entry.path + entry.search;
}

/**
 * RE2-compatible pattern (declarativeNetRequest regexFilter) that also runs as a
 * plain JS RegExp, so the popup and the block page can reuse it for previewing.
 */
export function buildRegex(entry, wwwEquivalent) {
  const host = entry.host;
  let hostPart;
  if (wwwEquivalent && hasWwwVariant(host)) {
    const bare = host.startsWith("www.") ? host.slice(4) : host;
    hostPart = "(?:www\\.)?" + escapeRe(bare);
  } else {
    hostPart = escapeRe(host);
  }

  // No port given: match the default port and any explicit one.
  const portPart = entry.port ? ":" + entry.port : "(?::\\d+)?";

  // Path prefix must end at a boundary, so /r/all never swallows /r/allergies.
  const prefix = (entry.path || "") + (entry.search || "");
  const tailPart = prefix ? escapeRe(prefix) + "(?:[/?#&].*)?$" : "(?:[/?#].*)?$";

  return "^https?://" + hostPart + portPart + tailPart;
}

/** Compiled matchers for the currently active entries. */
export function activeMatchers(state) {
  if (!state.enabled) return [];
  return state.entries
    .filter((e) => e.on !== false)
    .map((e) => ({ entry: e, re: new RegExp(buildRegex(e, state.wwwEquivalent), "i") }));
}

/** First entry that blocks the given URL, or null. */
export function matchEntry(state, url) {
  for (const m of activeMatchers(state)) {
    if (m.re.test(url)) return m.entry;
  }
  return null;
}
