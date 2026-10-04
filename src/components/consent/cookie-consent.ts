// src/components/consent/cookie-consent.ts
//
// Self-contained cookie consent (UK PECR / ICO), no third-party platform and
// no dependencies. Reusable: copy the consent/ folder to another site and set
// the attributes on <CookieConsent /> (tracker ids, policy link, cookie name).
// Comic Strip Canvas loads Google Analytics 4 directly (data-ga4), only after
// consent, and sends shopping events through track() below.
//
// Rules it enforces:
// - Nothing non-essential loads until the visitor clicks "Accept all".
//   Trackers are injected from here; the page itself contains no tracker tags.
// - "Accept all" and "Reject all" are equal; no pre-ticked anything.
// - The choice is stored for ~6 months in a first-party cookie (itself
//   strictly necessary: it records the choice). After that the banner asks again.
// - Any element with [data-cookie-settings] reopens the banner. Rejecting after
//   accepting switches the trackers off on the current page, clears their
//   cookies, and they don't load again. Every page load while the choice is
//   "rejected" also clears any tracker cookies left behind.
//
// Essential storage (sessions, payments, chat history, booking) is not
// touched by this module.

type Choice = "accepted" | "rejected";

interface Config {
  cookieName: string;
  maxAgeDays: number;
  ga4Id?: string;
  metaPixelId?: string;
  gtmId?: string;
}

const SIX_MONTHS_DAYS = 182;
const VERSION = "v1"; // bump to ask everyone again (e.g. new tracker added)

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    fbq?: any;
    _fbq?: any;
    /** The GA4 id while analytics is running with consent; unset otherwise. */
    __ga4Active?: string;
  }
}

/* ---------------- stored choice ---------------- */

function readChoice(cfg: Config): Choice | null {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${cfg.cookieName}=([^;]*)`));
  if (!m) return null;
  const [version, choice] = decodeURIComponent(m[1]).split(":");
  if (version !== VERSION) return null;
  return choice === "accepted" || choice === "rejected" ? choice : null;
}

function writeChoice(cfg: Config, choice: Choice) {
  const value = encodeURIComponent(`${VERSION}:${choice}:${Date.now()}`);
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${cfg.cookieName}=${value}; Max-Age=${cfg.maxAgeDays * 86400}; Path=/; SameSite=Lax${secure}`;
}

/* ---------------- trackers (only ever called after consent) ---------------- */

let trackersLoaded = false;

/**
 * A URL with its query string and hash removed when it carries something that
 * should not reach Google: the Stripe session id on /order-confirmation, or a
 * personalisation reference (pp-<hex>). Anything else is returned unchanged.
 */
function cleanUrl(href: string): string {
  try {
    const u = new URL(href);
    if (u.origin !== location.origin) return href;
    if (u.pathname.startsWith("/order-confirmation") || /pp-[0-9a-f]{32}/i.test(u.search + u.hash)) {
      return u.origin + u.pathname;
    }
    return href;
  } catch {
    return href;
  }
}

function loadGA4(id: string) {
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  // Before js/config: analytics only, never advertising.
  window.gtag("consent", "default", {
    analytics_storage: "granted",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
  window.gtag("js", new Date());
  const params: Record<string, string> = {};
  const loc = cleanUrl(location.href);
  if (loc !== location.href) params.page_location = loc;
  if (document.referrer) {
    const ref = cleanUrl(document.referrer);
    if (ref !== document.referrer) params.page_referrer = ref;
  }
  window.gtag("config", id, params);
  window.__ga4Active = id;
}

/** Accepting again on a page where the visitor had just withdrawn. */
function resumeGA4(id: string) {
  (window as unknown as Record<string, boolean>)[`ga-disable-${id}`] = false;
  window.gtag?.("consent", "update", { analytics_storage: "granted" });
  window.__ga4Active = id;
}

function loadMetaPixel(id: string) {
  // Meta's standard base code, run only now.
  if (window.fbq) return;
  const n: any = (window.fbq = function (...args: unknown[]) {
    n.callMethod ? n.callMethod.apply(n, args) : n.queue.push(args);
  });
  if (!window._fbq) window._fbq = n;
  n.push = n;
  n.loaded = true;
  n.version = "2.0";
  n.queue = [];
  const s = document.createElement("script");
  s.async = true;
  s.src = "https://connect.facebook.net/en_US/fbevents.js";
  document.head.appendChild(s);
  window.fbq("init", id);
  window.fbq("track", "PageView");
}

function loadGTM(id: string) {
  // Google's standard container snippet, run only now. There is deliberately
  // no <noscript> iframe fallback: it would load without consent.
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ "gtm.start": new Date().getTime(), event: "gtm.js" });
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(id)}`;
  document.head.appendChild(s);
}

function loadTrackers(cfg: Config) {
  if (trackersLoaded) {
    if (cfg.ga4Id && !window.__ga4Active) resumeGA4(cfg.ga4Id);
    return;
  }
  trackersLoaded = true;
  if (cfg.ga4Id) loadGA4(cfg.ga4Id);
  if (cfg.metaPixelId) loadMetaPixel(cfg.metaPixelId);
  if (cfg.gtmId) loadGTM(cfg.gtmId);
}

/**
 * Remove tracker cookies set on this site's own domain: host-only and every
 * parent domain (e.g. .themetavision.co.uk). Used on withdrawal and on every
 * page load while the choice is "rejected".
 */
function clearTrackerCookies() {
  const names = document.cookie
    .split(";")
    .map((c) => c.split("=")[0].trim())
    // Google Analytics / Ads (_ga, _gid, _gat, _gcl_*), Meta (_fbp, _fbc),
    // Microsoft Ads / Clarity (_uet*, _clck, _clsk), TikTok (_ttp), Pinterest (_pin_unauth).
    .filter((n) => /^(_ga|_ga_.+|_gid|_gat.*|_gcl_.+|_fbp|_fbc|_uet.+|_clck|_clsk|_ttp|_pin_unauth)$/.test(n));
  const parts = location.hostname.split(".");
  const domains = [""];
  for (let i = 0; i < parts.length - 1; i++) domains.push(`; Domain=.${parts.slice(i).join(".")}`);
  for (const name of names) {
    for (const d of domains) document.cookie = `${name}=; Max-Age=0; Path=/${d}`;
  }
}

/**
 * On withdrawal: switch off trackers already running on this page, so they
 * can't write their cookies again after we clear them.
 */
function stopRunningTrackers(cfg: Config) {
  // GA4: Google's opt-out flag, per measurement ID. The configured id always,
  // plus any from a _ga_<ID> cookie (e.g. one left by GA4 loaded through GTM).
  window.__ga4Active = undefined;
  const ids = new Set<string>();
  if (cfg.ga4Id) ids.add(cfg.ga4Id);
  for (const c of document.cookie.split(";")) {
    const m = c.trim().match(/^_ga_([A-Z0-9]+)=/);
    if (m) ids.add(`G-${m[1]}`);
  }
  for (const id of ids) (window as unknown as Record<string, boolean>)[`ga-disable-${id}`] = true;
  // Consent Mode: Google tags, including those inside a GTM container, stop
  // using cookies once storage is denied.
  if (window.dataLayer) {
    window.gtag =
      window.gtag ||
      function gtag() {
        // eslint-disable-next-line prefer-rest-params
        window.dataLayer!.push(arguments);
      };
    window.gtag("consent", "update", {
      analytics_storage: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
  }
  // Meta Pixel: stop sending events and setting cookies.
  if (window.fbq) window.fbq("consent", "revoke");
}

/* ---------------- events (no-ops without consent) ---------------- */

/** Pages and builder modes that are ours, not a shopper's. */
function staffContext(): boolean {
  if (location.pathname.startsWith("/admin")) return true;
  const mode = document.getElementById("csc-builder-root")?.dataset.mode;
  return mode === "studio" || mode === "admin";
}

/**
 * Send a GA4 event. Does nothing unless the visitor accepted analytics and
 * gtag is loaded; never queues to dataLayer ahead of consent, because a queue
 * would be sent on a later "Accept all". Never fires in staff contexts.
 */
export function track(name: string, params: Record<string, unknown> = {}) {
  try {
    if (!window.__ga4Active || typeof window.gtag !== "function" || staffContext()) return;
    window.gtag("event", name, params);
  } catch {
    /* analytics never breaks the page */
  }
}

/**
 * The GA4 client id and session id, asked for together under one deadline:
 * whatever gtag has answered by timeoutMs is returned, and anything it has not
 * is left undefined. Both undefined when analytics is off. Used at checkout so
 * the server can send the purchase into the visitor's own session.
 */
export function getGaIds(timeoutMs = 500): Promise<{ clientId?: string; sessionId?: string }> {
  const id = window.__ga4Active;
  if (!id || typeof window.gtag !== "function" || staffContext()) return Promise.resolve({});
  return new Promise((resolve) => {
    const ids: { clientId?: string; sessionId?: string } = {};
    let pending = 2;
    const done = () => { clearTimeout(timer); resolve(ids); };
    const timer = setTimeout(() => resolve({ ...ids }), timeoutMs);
    const answer = (key: "clientId" | "sessionId") => (value: unknown) => {
      if (value !== undefined && value !== null && String(value)) ids[key] = String(value);
      if (--pending === 0) done();
    };
    try {
      window.gtag!("get", id, "client_id", answer("clientId"));
      window.gtag!("get", id, "session_id", answer("sessionId"));
    } catch {
      done();
    }
  });
}

/* ---------------- banner ---------------- */

export function initCookieConsent(root: HTMLElement | null = document.getElementById("cookie-consent")) {
  if (!root) return;
  const cfg: Config = {
    cookieName: root.dataset.cookieName || "site_consent",
    maxAgeDays: Number(root.dataset.maxAgeDays) || SIX_MONTHS_DAYS,
    ga4Id: root.dataset.ga4 || undefined,
    metaPixelId: root.dataset.metaPixel || undefined,
    gtmId: root.dataset.gtm || undefined,
  };
  const accept = root.querySelector<HTMLButtonElement>("[data-cc-accept]")!;
  const reject = root.querySelector<HTMLButtonElement>("[data-cc-reject]")!;
  const status = root.querySelector<HTMLElement>("[data-cc-status]");
  const announcer = document.getElementById("cookie-consent-announcer");
  let returnFocusTo: HTMLElement | null = null;

  const show = (reopened: boolean) => {
    const current = readChoice(cfg);
    if (status) {
      status.hidden = !current;
      status.textContent = current
        ? `Currently: analytics cookies are ${current === "accepted" ? "on" : "off"}.`
        : "";
    }
    root.hidden = false;
    if (reopened) accept.focus();
  };
  const hide = () => {
    root.hidden = true;
    returnFocusTo?.focus();
    returnFocusTo = null;
  };
  const decide = (choice: Choice) => {
    const previous = readChoice(cfg);
    writeChoice(cfg, choice);
    if (choice === "accepted") loadTrackers(cfg);
    if (choice === "rejected" && previous === "accepted") {
      stopRunningTrackers(cfg);
      clearTrackerCookies();
      setTimeout(clearTrackerCookies, 1500);
    }
    if (announcer) {
      announcer.textContent =
        choice === "accepted"
          ? "Saved: analytics cookies are on."
          : "Saved: analytics cookies are off.";
    }
    hide();
  };

  accept.addEventListener("click", () => decide("accepted"));
  reject.addEventListener("click", () => decide("rejected"));
  root.addEventListener("keydown", (e) => {
    // Escape only dismisses a reopened banner; a first visit still needs a choice.
    if (e.key === "Escape" && readChoice(cfg)) hide();
  });
  document.addEventListener("click", (e) => {
    const trigger = (e.target as Element | null)?.closest?.("[data-cookie-settings]");
    if (!trigger) return;
    e.preventDefault();
    returnFocusTo = trigger as HTMLElement;
    show(true);
  });

  const choice = readChoice(cfg);
  if (choice === "accepted") loadTrackers(cfg);
  else if (choice === "rejected") clearTrackerCookies();
  else show(false);
}
