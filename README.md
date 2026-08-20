# Gaming News Ticker

A live feed of freshly-published gaming articles (publisher RSS + Reddit), refreshed on a
schedule and shown on a self-updating web page — hosted for free on GitHub.

## How it works

1. **`poller.py`** fetches every feed in `sources.json`, figures out which entries are new
   since the last run (tracked in `data/seen_ids.json`), and writes the merged, deduped,
   most-recent-first list to `docs/feed.json`.
2. **`.github/workflows/poll.yml`** runs the poller on a schedule (every 5 minutes — GitHub's
   practical floor for scheduled workflows) and commits the updated `feed.json` back to the repo.
3. **`docs/index.html`** is a static page (served by GitHub Pages) that polls `feed.json` from
   the browser every 30 seconds and renders the live list, newest first, with a brief highlight
   flash on anything new. No backend server needed — GitHub hosts all of it.

## Setup (one-time)

1. Create a new GitHub repo and push this folder to it.
2. In the repo, go to **Settings → Pages** and set the source to the `docs/` folder on your
   default branch. GitHub will give you a URL like `https://<you>.github.io/<repo>/` — that's
   your live ticker page.
3. Go to **Settings → Actions → General** and make sure Actions are enabled, and that
   **Workflow permissions** is set to "Read and write permissions" (needed so the poller can
   commit updates back).
4. Go to the **Actions** tab, find "Poll news sources," and click **Run workflow** once to
   confirm it works, before waiting for the schedule.
5. (Optional) If you want an instant Slack ping too, not just the dashboard: create a Slack
   Incoming Webhook URL, add it as a repo secret named `SLACK_WEBHOOK_URL`
   (Settings → Secrets and variables → Actions), and the poller will post new items there
   automatically — no code changes needed.

That's it. From then on it runs unattended: every ~5 minutes GitHub checks all sources, and
your ticker page picks up anything new within 30 seconds of that.

## On "instant"

True stock-ticker instant (sub-minute) would need an always-on process rather than a scheduled
job — this chat session can't host that (it isn't always-on either), and GitHub Actions'
practical floor is ~5 minutes, sometimes more under load. If you outgrow that:

- **Cloudflare Workers + Cron Triggers** support 1-minute schedules on the free tier and can
  also serve the page — a rewrite of `poller.py`'s logic into a Worker, with KV instead of
  files in git. Ask me to build this version if 5 minutes isn't fast enough.
- A small always-on VM/container you control (Render, Fly.io, a VPS) polling every 30-60s is
  the truest to "instant" but costs money and needs upkeep.

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
