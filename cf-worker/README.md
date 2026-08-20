# News Feed Worker

Cloudflare Worker version of the gaming news ticker. Replaces the original GitHub Actions +
Pages setup (see the repo root README) because GitHub's schedule trigger fired far less
reliably than its "every 5 minutes" configuration promised.

**Live:** https://news-feed-worker.newsfeedsubdomain.workers.dev

## How it works

- `src/index.js` -- everything: RSS/Atom parsing (`fast-xml-parser`), per-source item cap,
  retry/backoff for rate-limited sources (Reddit in particular), a KV-based lock so overlapping
  cron runs can't race on the same data, and the `fetch`/`scheduled` handlers.
- `src/sources.json` -- the list of publisher RSS feeds and subreddits to poll.
- `src/dashboard.html` -- the same static dashboard as the old `docs/index.html`, served
  directly by the Worker instead of GitHub Pages.
- Storage is a single Workers KV namespace (binding `FEED_KV`), one JSON blob under the key
  `feed` holding both the merged feed items and the dedupe `seenIds` set. No git commits
  involved in the live path.

## Cron interval and KV write budget

The Cron Trigger fires every 5 minutes (`wrangler.toml` -> `[triggers]`). Each successful cycle
does 3 KV writes (acquire lock, write feed data, release lock), so at 5-minute intervals that's
`(24*60/5) * 3 = 864` writes/day -- comfortably under Workers KV's free-tier cap of 1,000
writes/day. Don't drop the interval without recomputing this; a 2-minute interval was tried
first and both blew the write budget and (before the lock existed) caused overlapping runs to
race on the KV key, corrupting the feed with stale overwrites.

## Local development

```
cd cf-worker
npm install
npm run dev          # wrangler dev --local, runs entirely offline with simulated KV
```

`GET /poll-now` triggers a poll cycle in the background (fire-and-forget, same as the real cron
path -- a cycle can take minutes under Reddit's rate limiting, too long for an HTTP client to
wait on synchronously). Check progress by polling `GET /feed.json`.

## Deploying

```
npx wrangler login                      # one-time OAuth login to your Cloudflare account
npx wrangler kv namespace create FEED_KV   # one-time; paste the returned id into wrangler.toml
npx wrangler deploy
```

Optional Slack alerts: `npx wrangler secret put SLACK_WEBHOOK_URL` and paste an Incoming
Webhook URL. The poller posts new items there automatically once the secret exists -- no code
changes needed.

## Known constraints

- **Reddit rate limits aggressively.** `fetchSource()` retries 429s with backoff, and there's
  an 8-second delay around every Reddit request (vs. 1.5s for publisher sites). Even so, expect
  occasional subreddits to miss a cycle -- their previously-fetched items just stay in the feed
  (per-source cap keeps up to 25 most-recent per source) until the next successful fetch.
- **Per-source cap (25) exists to stop high-volume publishers (Game Rant, IGN) from crowding
  slower ones (VG247, quieter subreddits) out of the feed entirely.** The overall safety cap
  (`MAX_FEED_ITEMS = 700`) is intentionally set above `sources.length * PER_SOURCE_CAP` so it
  never binds in normal operation -- if you add many more sources, recheck that inequality.
- **fast-xml-parser's default entity-expansion limit (1000) is too low for Reddit's
  HTML-entity-heavy Atom feeds** and will throw if not raised (see `processEntities` config in
  `src/index.js`).
