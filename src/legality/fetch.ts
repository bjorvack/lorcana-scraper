/**
 * Scrape Disney Lorcana's banlist + rotation calendar from lorcana.gg.
 *
 * Two URLs, both rendered as HTML with stable table layouts:
 *
 *   - https://lorcana.gg/banned-card-list/
 *       One "Current Banned Cards" table (Card Name | Effective Date)
 *       plus a Changelog list whose entries carry the structured
 *       ``<setCode>-<cardNumber>-<slug>`` identifiers we actually
 *       need. We parse the table for the human-readable list and the
 *       changelog for the structured ids; both are then joined into
 *       :class:`BanlistT` entries.
 *   - https://lorcana.gg/rotation/
 *       Three "Year N Set" tables (Set | Release Date | Rotation
 *       Date). Some rotation cells say e.g. ``"Q3 2026"`` because
 *       Ravensburger hasn't pinned the exact date yet; we normalise
 *       to the last day of that quarter (``2026-09-30``) so the
 *       output matches the schema's YYYY-MM-DD constraint. A
 *       ``forecastedDates`` array on the result captures which dates
 *       were inferred rather than read literally.
 *
 * Why a hand-rolled parser: the page schema is simple, cheerio is
 * already a dependency for tournament scraping, and our control
 * surface is "parse a table" — bringing in a markdown converter
 * would add weight without buying robustness.
 */

import * as cheerio from "cheerio";
import { fetch } from "undici";
import type { BanlistT, RotationT } from "@bjorvack/lorcana-schemas";

export const LORCANA_GG_BANLIST_URL = "https://lorcana.gg/banned-card-list/";
export const LORCANA_GG_ROTATION_URL = "https://lorcana.gg/rotation/";

// lorcana.gg sits behind Cloudflare which now reliably 403's the
// previous "lorcana-scraper/..." UA from GitHub-hosted runners.
// Locally (residential IP) the browser-shaped header set below is
// enough to clear the Browser Integrity Check. From GitHub-runner IP
// ranges Cloudflare's risk score is high enough that headers alone
// still 403 — we fall through to a Playwright-driven headless
// Chromium navigation (see ``fetchHtmlBrowser`` + ``fetchPage``).
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BROWSER_HEADERS: Record<string, string> = {
  "user-agent": USER_AGENT,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "accept-encoding": "gzip, deflate, br",
  "cache-control": "no-cache",
  pragma: "no-cache",
  referer: "https://lorcana.gg/",
  "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
};
const PER_REQUEST_TIMEOUT_MS = 30_000;
const RETRY_STATUS = new Set([403, 429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

export interface FetchedBanlist {
  readonly banlist: BanlistT;
  /** Names whose changelog entry didn't yield a (setCode, cardNumber). */
  readonly unresolved: readonly string[];
}

export interface FetchedRotation {
  readonly rotation: RotationT;
  /** Dates parsed from imprecise ("Q3 2026") source values. */
  readonly forecastedDates: readonly { block: string; field: string; original: string }[];
}

/** GET a URL as text with our standard timeout + browser-like
 * headers. Retries up to ``MAX_ATTEMPTS`` on transient Cloudflare
 * responses (403/429/5xx) with exponential backoff + jitter so a
 * single edge node hiccup doesn't fail the weekly scheduled run. */
export async function fetchHtml(url: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PER_REQUEST_TIMEOUT_MS);
    let retriable = false;
    let lastErr: Error = new Error(`${url}: fetch failed`);
    try {
      const res = await fetch(url, {
        headers: BROWSER_HEADERS,
        signal: controller.signal,
      });
      if (res.ok) return await res.text();
      // Drain the body so undici can recycle the connection.
      await res.arrayBuffer().catch(() => undefined);
      lastErr = new Error(`${url}: HTTP ${res.status} ${res.statusText}`);
      retriable = RETRY_STATUS.has(res.status);
    } catch (err) {
      // AbortError + network errors are worth retrying.
      lastErr = err instanceof Error ? err : new Error(String(err));
      retriable = true;
    } finally {
      clearTimeout(timeout);
    }
    if (!retriable || attempt === MAX_ATTEMPTS) throw lastErr;
    // 1s, 3s, … with up to 1s of jitter. Keeps the whole step
    // comfortably under the 30s timeout budget per URL.
    const backoffMs = 1000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000);
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  // Unreachable: the loop always either returns or throws.
  throw new Error(`${url}: fetch failed`);
}

/** GET a URL via headless Chromium. Used as the escalation path
 * when undici hits a Cloudflare wall (typically a 403 from
 * GitHub-runner IP ranges).
 *
 * Playwright is dynamic-imported so the unit suite — which never
 * exercises this path — doesn't have to bundle/load it. The browser
 * is launched fresh per call: each scrape only does two navigations
 * and re-using a context across them is not worth the extra
 * lifecycle code given how rarely this runs. */
export async function fetchHtmlBrowser(url: string): Promise<string> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: "en-US",
      extraHTTPHeaders: {
        "accept-language": BROWSER_HEADERS["accept-language"],
        referer: BROWSER_HEADERS.referer,
      },
    });
    const page = await context.newPage();
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: PER_REQUEST_TIMEOUT_MS,
    });
    // Both pages render the data we care about into <table>s. Waiting
    // for the first one keeps us robust against the page still being
    // mid-render when domcontentloaded fires; if no table ever
    // appears we still fall through and return whatever HTML we have
    // — the parser will then throw on missing selectors, which is
    // the right signal (page structure drifted).
    await page.waitForSelector("table", { timeout: 5_000 }).catch(() => undefined);
    return await page.content();
  } finally {
    await browser.close();
  }
}

/** Injection seam for ``fetchPage``. The defaults call the real
 * undici + playwright impls; tests substitute mocks. */
export interface PageFetchers {
  readonly undici?: (url: string) => Promise<string>;
  readonly browser?: (url: string) => Promise<string>;
}

const CLOUDFLARE_HTTP_MARKER = /HTTP (?:403|429|5\d\d)\b/;

/** Try undici first (fast, cheap), and on a Cloudflare-shaped
 * failure (403/429/5xx) escalate to a real headless browser. Any
 * other error — DNS, abort, schema-shaped parse problem — propagates
 * as-is so a real bug doesn't get masked by a 30-second browser
 * launch. */
export async function fetchPage(url: string, fetchers: PageFetchers = {}): Promise<string> {
  const undiciFetch = fetchers.undici ?? fetchHtml;
  const browserFetch = fetchers.browser ?? fetchHtmlBrowser;
  try {
    return await undiciFetch(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!CLOUDFLARE_HTTP_MARKER.test(msg)) throw err;
    process.stderr.write(`[fetchPage] ${msg} — escalating to headless browser\n`);
    return await browserFetch(url);
  }
}

/** Parse a date string into ISO ``YYYY-MM-DD``. Returns ``null`` for
 * unrecognised inputs so the caller can decide whether to bail or
 * forecast.
 *
 * lorcana.gg renders dates as ``"September 5, 2025"`` (Month Day, Year).
 * ``Date.parse`` accepts that format but treats it as **local** time;
 * pulling year/month/day off the parsed Date with ``getUTC*`` would
 * shift it by up to a day depending on the runner's timezone. We
 * parse with a small explicit regex so the YYYY-MM-DD we emit
 * matches the source text byte for byte regardless of TZ. */
const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;
export function parseAbsoluteDate(s: string): string | null {
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const monthIdx = MONTH_NAMES.indexOf(m[1]!.toLowerCase() as (typeof MONTH_NAMES)[number]);
  if (monthIdx < 0) return null;
  const day = parseInt(m[2]!, 10);
  const year = parseInt(m[3]!, 10);
  if (day < 1 || day > 31) return null;
  return `${year}-${String(monthIdx + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Best-effort quarter parsing for ``"Q3 2026"`` style cells.
 * Returns the *last* day of the quarter; consumers treat this as a
 * forecast (see ``forecastedDates``) rather than a contract. */
export function parseQuarter(s: string): string | null {
  const m = /^Q([1-4])\s+(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const q = Number(m[1]);
  const y = Number(m[2]);
  const lastMonth = q * 3; // Q1→3, Q2→6, Q3→9, Q4→12
  const lastDay = new Date(Date.UTC(y, lastMonth, 0)).getUTCDate();
  return `${y}-${String(lastMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

/** Parse either an absolute date or a "Q3 2026" style quarter,
 * returning ``{date, forecast: true}`` for the latter. */
export function parseDateOrQuarter(s: string): { date: string; forecast: boolean } | null {
  const abs = parseAbsoluteDate(s);
  if (abs) return { date: abs, forecast: false };
  const q = parseQuarter(s);
  if (q) return { date: q, forecast: true };
  return null;
}

// ---------- Banlist ------------------------------------------------

export async function scrapeBanlist(): Promise<FetchedBanlist> {
  const html = await fetchPage(LORCANA_GG_BANLIST_URL);
  const $ = cheerio.load(html);

  // The first <table> on the page is the "Current Banned Cards" list.
  const table = $("table").first();
  if (table.length === 0) {
    throw new Error("banlist HTML had no <table>; selector drift?");
  }

  // Each row's first cell wraps a ``<div class="RootOfEmbeddedCards"
  // data-cards="002-149-hiram-flaversham-toymaker">`` element. The
  // ``data-cards`` attribute is the authoritative structured id; the
  // visible text is a giant skeleton-loader CSS block that we can't
  // reliably parse a name from. Reading the data attribute gives us
  // ``(setCode, cardNumber, slug)`` in one hop, no fuzzy matching.
  const entries: BanlistT["formats"]["core_constructed"] = [];
  const unresolved: string[] = [];
  table.find("tbody tr").each((_, tr) => {
    const cells = $(tr).find("td");
    if (cells.length < 2) return;
    // Find the data-cards attribute anywhere in the first cell's
    // subtree. lorcana.gg consistently puts it on the embed-root div.
    const dataCards = $(cells[0]!).find("[data-cards]").attr("data-cards") ?? "";
    const idMatch = /^(\d{3,4})-(\d{3,4})-([a-z0-9-]+)$/i.exec(dataCards.trim());
    const effectiveText = $(cells[1]!).text().trim();
    const effective = parseAbsoluteDate(effectiveText);
    if (!idMatch || !effective) {
      // Capture the human-readable cell text on either failure so
      // the unresolved log surfaces something searchable.
      const fallbackName = $(cells[0]!).text().trim().slice(0, 64);
      if (fallbackName) unresolved.push(fallbackName);
      return;
    }
    const setCode = String(parseInt(idMatch[1]!, 10));
    const cardNumber = parseInt(idMatch[2]!, 10);
    // Reconstruct a human-readable name from the slug: turn dashes
    // into spaces and title-case each word. Source pages add this
    // back via the embed component at view time; we mirror the
    // convention here so callers reading the JSON see something
    // legible.
    const cardName = idMatch[3]!
      .split("-")
      .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
      .join(" ");
    entries.push({ cardName, setCode, cardNumber, effectiveDate: effective });
  });

  // lorcana.gg notes that pre-Set-9 the banlist applies to the single
  // "main competitive constructed" format, but our schema split is
  // pinned to core_constructed / infinity_constructed. Apply the
  // current list to both buckets until the page itself separates them.
  const banlist: BanlistT = {
    generatedAt: new Date().toISOString(),
    sourceUrl: LORCANA_GG_BANLIST_URL,
    schemaVersion: "1.0.0",
    formats: {
      core_constructed: entries,
      infinity_constructed: entries,
    },
  };
  return { banlist, unresolved };
}

// ---------- Rotation -----------------------------------------------

function extractSetCode(cellText: string): string | null {
  // "Set 1: The First Chapter" → "1"; "Set 10: Whispers..." → "10";
  // anything else stays null so the caller can drop the row.
  const m = /^Set\s+(\d+)/i.exec(cellText.trim());
  return m ? m[1]! : null;
}

export async function scrapeRotation(): Promise<FetchedRotation> {
  const html = await fetchPage(LORCANA_GG_ROTATION_URL);
  const $ = cheerio.load(html);

  const blocks: { name: string; setCodes: string[]; releaseDate: string; rotationDate: string }[] =
    [];
  const forecasted: { block: string; field: string; original: string }[] = [];

  $("table").each((_, table) => {
    const headers: string[] = [];
    $(table)
      .find("thead th, tr:first-child th")
      .each((__, th) => {
        headers.push($(th).text().trim());
      });
    const yearHeader = headers[0] ?? "";
    const m = /^(Year\s+\d+)\s+Set$/i.exec(yearHeader);
    if (!m) return;
    const name = m[1]!;

    const setCodes: string[] = [];
    let firstReleaseDate: string | null = null;
    let firstRotationDate: string | null = null;

    $(table)
      .find("tbody tr, tr:not(:first-child)")
      .each((__, tr) => {
        const cells = $(tr).find("td");
        if (cells.length < 3) return;
        const setText = $(cells[0]!).text().trim();
        const releaseText = $(cells[1]!).text().trim();
        const rotationText = $(cells[2]!).text().trim();

        const setCode = extractSetCode(setText);
        if (!setCode) return;
        setCodes.push(setCode);

        if (firstReleaseDate === null) {
          const r = parseDateOrQuarter(releaseText);
          if (r) {
            firstReleaseDate = r.date;
            if (r.forecast) {
              forecasted.push({ block: name, field: "releaseDate", original: releaseText });
            }
          }
        }
        if (firstRotationDate === null) {
          const r = parseDateOrQuarter(rotationText);
          if (r) {
            firstRotationDate = r.date;
            if (r.forecast) {
              forecasted.push({ block: name, field: "rotationDate", original: rotationText });
            }
          }
        }
      });

    if (setCodes.length > 0 && firstReleaseDate && firstRotationDate) {
      blocks.push({
        name,
        setCodes,
        releaseDate: firstReleaseDate,
        rotationDate: firstRotationDate,
      });
    }
  });

  if (blocks.length === 0) {
    throw new Error("rotation HTML had no recognisable Year-N tables; selector drift?");
  }

  const rotation: RotationT = {
    generatedAt: new Date().toISOString(),
    sourceUrl: LORCANA_GG_ROTATION_URL,
    schemaVersion: "1.0.0",
    blocks,
    // Page text says "two yearly blocks (eight sets) stay Core-legal"
    // → 24 months. We don't bother re-parsing the prose because it's
    // a stable constant and a derivation from the per-block dates
    // would be more brittle than the dates themselves.
    coreConstructedCutoffMonths: 24,
  };
  return { rotation, forecastedDates: forecasted };
}
