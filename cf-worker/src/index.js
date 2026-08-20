import { XMLParser } from "fast-xml-parser";
import sources from "./sources.json";
import dashboardHtml from "./dashboard.html";

const PER_SOURCE_CAP = 25;
const MAX_FEED_ITEMS = 700;
const MAX_SEEN_IDS = 6000;
const REQUEST_TIMEOUT_MS = 15000;
const USER_AGENT = "Mozilla/5.0 (compatible; NewsTickerBot/1.0; +https://github.com/)";
const FEED_KEY = "feed";
const LOCK_KEY = "poll:lock";
const LOCK_TTL_SECONDS = 280; // just over the 5-min cron interval; crash-recovery backstop

// fast-xml-parser caps entity expansions at 1000 by default (anti "billion
// laughs" guard). Reddit's Atom feeds legitimately blow past that with
// HTML-entity-heavy escaped content across ~25 entries, so raise it --
// still bounded, just sized for real feed content instead of the default.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: { enabled: true, maxTotalExpansions: 20000, maxExpandedLength: 2000000 },
});

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(v) {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && "#text" in v) return String(v["#text"]);
  return String(v);
}

function parsedDateToIso(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Normalizes both RSS 2.0 (<rss><channel><item>) and Atom (<feed><entry>) into
// a common shape. Reddit's .rss endpoints are actually Atom; publisher feeds
// are RSS 2.0 -- feedparser handled both transparently in Python, this is the
// JS equivalent.
function parseFeedXml(xmlText) {
  const doc = xmlParser.parse(xmlText);

  if (doc.rss && doc.rss.channel) {
    const items = asArray(doc.rss.channel.item);
    return items.map((entry) => ({
      guid: textOf(entry.guid) || textOf(entry.link) || null,
      link: textOf(entry.link),
      title: textOf(entry.title) || "(untitled)",
      published: parsedDateToIso(entry.pubDate) || parsedDateToIso(entry["dc:date"]),
    }));
  }

  if (doc.feed && doc.feed.entry) {
    const entries = asArray(doc.feed.entry);
    return entries.map((entry) => {
      const links = asArray(entry.link);
      const htmlLink = links.find((l) => l && l["@_rel"] !== "self") || links[0];
      const link = htmlLink ? htmlLink["@_href"] || textOf(htmlLink) : "";
      return {
        guid: textOf(entry.id) || link || null,
        link,
        title: textOf(entry.title) || "(untitled)",
        published: parsedDateToIso(entry.published) || parsedDateToIso(entry.updated),
      };
    });
  }

  return [];
}

async function fetchSource(name, url, category, maxRetries = 3) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (resp.status === 429 && attempt < maxRetries) {
        const retryAfter = parseInt(resp.headers.get("Retry-After") || "", 10);
        const wait = (Number.isFinite(retryAfter) ? retryAfter : 10 * (attempt + 1)) * 1000;
        console.warn(`[warn] ${name} rate-limited (429), retrying in ${wait / 1000}s...`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const xmlText = await resp.text();
      const entries = parseFeedXml(xmlText);
      const items = [];
      for (const entry of entries) {
        const idSource = entry.guid || entry.link || entry.title + url;
        items.push({
          id: await sha256(idSource),
          title: entry.title.trim(),
          link: entry.link || "",
          source: name,
          category,
          published: entry.published || new Date().toISOString(),
        });
      }
      return items;
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }
  console.warn(`[warn] failed to fetch ${name} (${url}): ${lastError}`);
  return [];
}

async function notifySlack(webhookUrl, newItems) {
  if (!webhookUrl || !newItems.length) return;
  const lines = newItems.slice(0, 20).map((it) => `*${it.source}*: <${it.link}|${it.title}>`);
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: lines.join("\n") }),
    });
  } catch (e) {
    console.warn(`[warn] slack notify failed: ${e}`);
  }
}

async function pollOnce(env) {
  // A full cycle can take minutes under Reddit backoff -- longer than the
  // cron interval in the worst case. Without a lock, an overlapping run
  // would read a stale KV snapshot and clobber the other run's results on
  // write (a lost-update race), which is exactly what caused sources to
  // flap in and out between checks during testing.
  const lockHeld = await env.FEED_KV.get(LOCK_KEY);
  if (lockHeld) {
    // Diagnostic only, piggybacking on the skip (no extra write vs. what a
    // full run would have cost) -- lets /feed.json report how often and
    // how long cycles are overlapping, instead of guessing from timestamps.
    const heldSinceMs = Date.parse(lockHeld);
    const ageMs = Number.isFinite(heldSinceMs) ? Date.now() - heldSinceMs : null;
    console.log(`[info] skipping run -- a poll has been in progress for ${ageMs}ms`);
    await env.FEED_KV.put(
      "poll:last_skip",
      JSON.stringify({ skipped_at: new Date().toISOString(), previous_run_age_ms: ageMs })
    );
    return;
  }
  const startedAt = new Date();
  await env.FEED_KV.put(LOCK_KEY, startedAt.toISOString(), { expirationTtl: LOCK_TTL_SECONDS });

  try {
    await pollOnceLocked(env, startedAt);
  } catch (e) {
    // Without this, a thrown error (e.g. a KV quota error, an unexpected
    // parse failure) vanishes silently -- indistinguishable in /feed.json
    // from "still running", which made a real crash impossible to tell
    // apart from a slow cycle during testing.
    console.error(`[error] poll cycle failed: ${e && e.stack ? e.stack : e}`);
    await env.FEED_KV.put(
      "poll:last_error",
      JSON.stringify({
        at: new Date().toISOString(),
        started_at: startedAt.toISOString(),
        message: String(e && e.message ? e.message : e),
      })
    );
  } finally {
    await env.FEED_KV.delete(LOCK_KEY);
  }
}

async function pollOnceLocked(env, startedAt) {
  const stored = (await env.FEED_KV.get(FEED_KEY, "json")) || { items: [], seenIds: [] };
  const seenSet = new Set(stored.seenIds || []);
  const existingById = new Map((stored.items || []).map((it) => [it.id, it]));

  // Reddit first, publisher sites last: Reddit's rate-limit backoff can eat
  // several minutes of a cycle, and whatever is fetched right before the
  // single KV write at the end is the freshest data users actually see.
  // Fetching fast-moving sites first (as originally written) meant their
  // already-fresh data sat waiting, invisible, for however long Reddit's
  // retries took -- directly inflating the "how old is the newest item"
  // number for no reason, since sites don't need Reddit's slowness to
  // become their own staleness.
  const allSources = [
    ...sources.reddit.map((s) => ({ ...s, category: "reddit" })),
    ...sources.sites.map((s) => ({ ...s, category: "site" })),
  ];

  const allFetched = [];
  for (let i = 0; i < allSources.length; i++) {
    const s = allSources[i];
    const items = await fetchSource(s.name, s.url, s.category);
    allFetched.push(...items);

    if (i < allSources.length - 1) {
      const next = allSources[i + 1];
      const delayMs = s.category === "reddit" || next.category === "reddit" ? 8000 : 1500;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  const newItems = allFetched.filter((it) => !seenSet.has(it.id));

  const merged = new Map(existingById);
  for (const it of allFetched) merged.set(it.id, it);

  const bySource = new Map();
  for (const it of merged.values()) {
    if (!bySource.has(it.source)) bySource.set(it.source, []);
    bySource.get(it.source).push(it);
  }

  let perSourceCapped = [];
  for (const items of bySource.values()) {
    items.sort((a, b) => (a.published < b.published ? 1 : -1));
    perSourceCapped.push(...items.slice(0, PER_SOURCE_CAP));
  }

  const combined = perSourceCapped
    .sort((a, b) => (a.published < b.published ? 1 : -1))
    .slice(0, MAX_FEED_ITEMS);

  let seenIds = [...new Set([...seenSet, ...allFetched.map((it) => it.id)])];
  if (seenIds.length > MAX_SEEN_IDS) {
    const keep = new Set(combined.map((it) => it.id));
    seenIds = [...keep].slice(0, MAX_SEEN_IDS);
  }

  const finishedAt = new Date();
  await env.FEED_KV.put(
    FEED_KEY,
    JSON.stringify({
      generated_at: finishedAt.toISOString(),
      items: combined,
      seenIds,
      poll_started_at: startedAt.toISOString(),
      poll_duration_ms: finishedAt.getTime() - startedAt.getTime(),
    })
  );

  if (newItems.length) {
    console.log(`[info] ${newItems.length} new item(s) found.`);
  } else {
    console.log("[info] no new items this run.");
  }

  await notifySlack(env.SLACK_WEBHOOK_URL, newItems);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollOnce(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/feed.json") {
      const stored = (await env.FEED_KV.get(FEED_KEY, "json")) || {
        generated_at: null,
        items: [],
      };
      const lastSkip = await env.FEED_KV.get("poll:last_skip", "json");
      const lastError = await env.FEED_KV.get("poll:last_error", "json");
      const lockHeld = await env.FEED_KV.get(LOCK_KEY);
      return new Response(
        JSON.stringify({
          generated_at: stored.generated_at,
          items: stored.items,
          poll_started_at: stored.poll_started_at,
          poll_duration_ms: stored.poll_duration_ms,
          last_skip: lastSkip || null,
          last_error: lastError || null,
          lock_held_since: lockHeld || null,
        }),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } }
      );
    }

    if (url.pathname === "/poll-now") {
      // Manual trigger for testing -- not linked from the dashboard. Fire
      // and forget via waitUntil, same as the real cron path: a poll cycle
      // can take minutes under Reddit backoff, longer than any HTTP client
      // should be expected to stay connected for.
      ctx.waitUntil(pollOnce(env));
      return new Response("started");
    }

    return new Response(dashboardHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};
