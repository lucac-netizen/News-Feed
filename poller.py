#!/usr/bin/env python3
"""
Gaming news ticker poller.

Fetches all sources in sources.json, figures out which entries are new
since the last run, and updates docs/feed.json (served live by GitHub
Pages) plus data/seen_ids.json (dedupe memory across runs).

Run on a schedule (see .github/workflows/poll.yml). Safe to run manually:
    pip install -r requirements.txt
    python poller.py
"""
import json
import os
import sys
import time
import hashlib
from datetime import datetime, timezone

import feedparser
import requests

ROOT = os.path.dirname(os.path.abspath(__file__))
SOURCES_PATH = os.path.join(ROOT, "sources.json")
SEEN_PATH = os.path.join(ROOT, "data", "seen_ids.json")
FEED_OUT_PATH = os.path.join(ROOT, "docs", "feed.json")

MAX_FEED_ITEMS = 300      # how many recent items the live page keeps
MAX_SEEN_IDS = 6000       # dedupe memory cap (oldest trimmed first)
REQUEST_TIMEOUT = 15
USER_AGENT = "Mozilla/5.0 (compatible; NewsTickerBot/1.0; +https://github.com/)"

SLACK_WEBHOOK_URL = os.environ.get("SLACK_WEBHOOK_URL")  # optional


def load_json(path, default):
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return default


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def item_id(entry, fallback_url):
    """Stable id for dedupe: prefer guid/id, fall back to link, fall back to hash of title+source."""
    raw = entry.get("id") or entry.get("link") or (entry.get("title", "") + fallback_url)
    return hashlib.sha256(raw.encode("utf-8", "ignore")).hexdigest()


def parse_published(entry):
    for key in ("published_parsed", "updated_parsed"):
        t = entry.get(key)
        if t:
            return datetime.fromtimestamp(time.mktime(t), tz=timezone.utc).isoformat()
    return datetime.now(timezone.utc).isoformat()


def fetch_source(name, url, category):
    try:
        resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        parsed = feedparser.parse(resp.content)
    except Exception as e:
        print(f"[warn] failed to fetch {name} ({url}): {e}", file=sys.stderr)
        return []

    items = []
    for entry in parsed.entries:
        items.append({
            "id": item_id(entry, url),
            "title": (entry.get("title") or "(untitled)").strip(),
            "link": entry.get("link", ""),
            "source": name,
            "category": category,
            "published": parse_published(entry),
        })
    return items


def notify_slack(new_items):
    if not SLACK_WEBHOOK_URL or not new_items:
        return
    lines = [f"*{it['source']}*: <{it['link']}|{it['title']}>" for it in new_items[:20]]
    text = "\n".join(lines)
    try:
        requests.post(SLACK_WEBHOOK_URL, json={"text": text}, timeout=10)
    except Exception as e:
        print(f"[warn] slack notify failed: {e}", file=sys.stderr)


def main():
    sources = load_json(SOURCES_PATH, {})
    seen_ids = load_json(SEEN_PATH, [])
    seen_set = set(seen_ids)

    existing_feed = load_json(FEED_OUT_PATH, {"items": []})
    existing_items = existing_feed.get("items", [])
    existing_by_id = {it["id"]: it for it in existing_items}

    all_fetched = []
    for s in sources.get("sites", []):
        all_fetched.extend(fetch_source(s["name"], s["url"], "site"))
    for s in sources.get("reddit", []):
        all_fetched.extend(fetch_source(s["name"], s["url"], "reddit"))

    new_items = [it for it in all_fetched if it["id"] not in seen_set]

    # Merge: new items + anything already stored, dedupe by id, sort by published desc, cap length.
    merged = {**existing_by_id}
    for it in all_fetched:
        merged[it["id"]] = it  # refresh in case metadata changed
    combined = sorted(merged.values(), key=lambda x: x["published"], reverse=True)[:MAX_FEED_ITEMS]

    now_iso = datetime.now(timezone.utc).isoformat()
    save_json(FEED_OUT_PATH, {"generated_at": now_iso, "items": combined})

    seen_ids = list(seen_set.union(it["id"] for it in all_fetched))
    if len(seen_ids) > MAX_SEEN_IDS:
        # trim: keep the ids that are still present in `combined` plus most recent overflow
        keep = set(it["id"] for it in combined)
        seen_ids = list(keep)[:MAX_SEEN_IDS]
    save_json(SEEN_PATH, seen_ids)

    if new_items:
        print(f"[info] {len(new_items)} new item(s) found.")
        for it in new_items[:20]:
            print(f"  + [{it['source']}] {it['title']} -> {it['link']}")
    else:
        print("[info] no new items this run.")

    notify_slack(new_items)


if __name__ == "__main__":
    main()
