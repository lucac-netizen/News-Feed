# Gaming News Ticker

A live feed of freshly-published gaming articles (publisher RSS + Reddit), polled on a schedule
and shown on a self-updating web page.

**Live site:** https://news-feed-worker.newsfeedsubdomain.workers.dev

## How it works (current: Cloudflare Worker)

The live system is `cf-worker/` — see [`cf-worker/README.md`](cf-worker/README.md) for details.
In short: a Cloudflare Worker polls all sources every 5 minutes via a Cron Trigger, stores the
merged/deduped feed in Workers KV, and serves both the JSON feed and the dashboard itself from
the same Worker. No GitHub Actions or Pages involved in the live path anymore.

## Legacy: GitHub Actions + Pages (retired 2026-08-20)

The original version of this project (`poller.py`, `.github/workflows/poll.yml`, `docs/`) ran
on GitHub Actions + Pages instead. It's kept in the repo for reference but its schedule trigger
is disabled — GitHub's schedule trigger turned out to fire far less reliably than advertised in
practice (observed gaps of 20-60+ minutes against a configured 5-minute interval, vs. Cloudflare
Cron Triggers which fire on time). The `docs/` dashboard and `poller.py` still work if manually
triggered (`workflow_dispatch` from the Actions tab), but nothing updates them automatically
anymore. If you ever want to resurrect this path, re-add the `schedule:` trigger removed from
`poll.yml`.

## On "instant"

True stock-ticker instant (sub-minute) would need an always-on process rather than a scheduled
job. Cloudflare Cron Triggers support down to 1-minute schedules, but Workers KV's free tier
write budget (1,000 writes/day) caps how often a poll-and-write cycle can safely run — the
current 5-minute interval was chosen to stay safely under that with room for the concurrency
lock's extra writes (see `cf-worker/README.md`). A small always-on VM/container you control
(Render, Fly.io, a VPS) polling every 30-60s would get closer to true "instant" but costs money
and needs upkeep.

## Sources included

16 publisher RSS feeds (Kotaku, IGN, Polygon, PC Gamer, Eurogamer, GamesRadar, Rock Paper
Shotgun, VG247, Destructoid, TheGamer, Game Rant, Nintendo Life, Push Square, PCGamesN, Dot
Esports, Automaton) and 7 gaming subreddits. A few of the publisher URLs are flagged
`"confidence": "low"` or `"medium"` in `sources.json` — RSS URLs move without notice, so give
those a quick check (`curl -I <url>`) after setup, and the poller will just silently skip (and
log a warning for) any that fail.

**Not included: Twitter/X.** As of 2026 there's no functioning free or cheap way to watch
specific X accounts/keywords in real time — X killed its subscription API tiers for pure
pay-per-use with no free tier, and Nitter-style workarounds are unreliable. If you still want
it, the realistic options are paying for X's pay-per-use API (per-read pricing, 7-day
lookback only) or accepting a fragile scraper. Reddit RSS still works without login today but
is flagged as at-risk — Reddit has been tightening this — so if it breaks, that's expected and
migrating to Reddit's official API is the durable fix.

## Extending this into full article drafts

Right now this only surfaces headline + link — it doesn't write anything. If you later want it
to also draft an article off of a new item (the original "pump out news articles" idea), the
clean extension point is: whenever `poller.py` finds a new item, instead of (or in addition to)
appending it to the feed, fetch the source article's full text and hand it to an LLM with a
drafting prompt, then save the draft somewhere (a Google Doc, a CMS draft, another file in this
repo). Worth doing as a second phase once the detection side is proven out — happy to build
that next.
