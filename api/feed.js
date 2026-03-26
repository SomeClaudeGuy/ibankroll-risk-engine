'use strict';

// ── Betby Promo Feed ──────────────────────────────────────────────────────────
// Server-to-server feed providing prematch odds for all events on the platform.
// Feed updates every 10 minutes; we cache for the same duration.

const CACHE_TTL = 600_000; // 10 minutes

let _cache = null; // { events: [], ts: number }

function getFeedUrl() {
  const brandId = process.env.BETBY_BRAND_ID;
  if (!brandId || brandId === 'yourbrandID') throw new Error('BETBY_BRAND_ID env var not set');
  const env = process.env.BETBY_ENV || 'beta';
  return env === 'prod'
    ? `https://api-raeth4un-feed.sptpub.com/api/v1/promofeed/brand/${brandId}/en`
    : `https://api.invisiblesport.com/api/v1/promofeed/brand/${brandId}/en`;
}

// ── Market / outcome maps ─────────────────────────────────────────────────────
const MARKET_NAMES = {
  '1':   '1x2',
  '11':  'Draw No Bet',
  '186': 'Winner',
  '219': 'Winner (incl. OT)',
  '251': 'Winner (incl. extra innings)',
  '340': 'Winner (incl. super over)',
  '406': 'Winner (incl. OT + penalties)',
};

// Outcome IDs 1/3/4/5 use team names — substituted at parse time
const GENERIC_OUTCOME_NAMES = { '2': 'Draw' };

// ── Parse raw feed array into clean event objects ─────────────────────────────
function parseFeed(raw) {
  if (!Array.isArray(raw)) throw new Error('Feed response is not an array');

  // First pass: collect event descriptors keyed by event ID
  const eventMap = {};
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [keyArr, payload] = entry;
    if (!Array.isArray(keyArr) || keyArr.length < 2) continue;
    if (keyArr[1] === 'desc') {
      eventMap[keyArr[0]] = { ...payload, markets: {} };
    }
  }

  // Second pass: attach market entries to their event
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [keyArr, payload] = entry;
    if (!Array.isArray(keyArr) || keyArr.length < 3) continue;
    if (keyArr[1] === 'market') {
      const evId    = keyArr[0];
      const mktId   = keyArr[2];
      const ev      = eventMap[evId];
      if (!ev) continue;
      // Flatten specifier wrapper — payload is { "": { outcomeId: { k: "odds" } } }
      const specifiers = Object.values(payload);
      for (const outcomes of specifiers) {
        ev.markets[mktId] = ev.markets[mktId] || {};
        for (const [outcomeId, data] of Object.entries(outcomes)) {
          ev.markets[mktId][outcomeId] = parseFloat(data.k);
        }
      }
    }
  }

  const nowSec = Date.now() / 1000;

  // Clean and filter
  return Object.values(eventMap)
    .filter(ev => {
      if (ev.virtual) return false;
      if (!ev.competitors || ev.competitors.length < 2) return false;
      if (ev.scheduled && ev.scheduled < nowSec - 3600) return false; // skip past events
      return true;
    })
    .map(ev => ({
      id:         ev.id,
      scheduled:  ev.scheduled,
      sport:      ev.sport,
      category:   ev.category,
      tournament: ev.tournament,
      homeTeam:   { id: ev.competitors[0].id, name: ev.competitors[0].name },
      awayTeam:   { id: ev.competitors[1].id, name: ev.competitors[1].name },
      markets:    ev.markets,
    }));
}

// ── Fetch and cache ───────────────────────────────────────────────────────────
async function fetchAndParse() {
  const url = getFeedUrl();
  console.log('[feed] Fetching', url);
  const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!resp.ok) throw new Error(`Feed HTTP ${resp.status}`);
  const raw = await resp.json();
  return parseFeed(raw);
}

async function getFeedEvents(allowStale = true) {
  const now = Date.now();
  if (_cache && (now - _cache.ts) < CACHE_TTL) {
    console.log('[feed] Cache hit —', _cache.events.length, 'events');
    return _cache.events;
  }
  try {
    const events = await fetchAndParse();
    _cache = { events, ts: now };
    console.log('[feed] Fetched', events.length, 'events');
    return events;
  } catch (err) {
    if (allowStale && _cache) {
      console.warn('[feed] Fetch failed, serving stale cache:', err.message);
      return _cache.events;
    }
    throw err;
  }
}

// ── Fuzzy team matching ───────────────────────────────────────────────────────
function normalise(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamMatch(query, teamName) {
  const q = normalise(query);
  const t = normalise(teamName);
  if (!q || !t) return false;
  if (t.includes(q) || q.includes(t)) return true;
  const qWords = q.split(' ').filter(w => w.length > 2);
  return qWords.length > 0 && qWords.every(w => t.includes(w));
}

// Find an event from a slug like "boston celtics oklahoma city thunder"
function findEventBySlug(events, slug) {
  const words = normalise(slug).split(' ');
  const nowSec = Date.now() / 1000;
  // Prefer events starting within next 7 days
  const upcoming = events
    .filter(ev => !ev.scheduled || ev.scheduled >= nowSec)
    .sort((a, b) => (a.scheduled || 0) - (b.scheduled || 0));
  return upcoming.find(ev => {
    const homeWords = normalise(ev.homeTeam.name).split(' ').filter(w => w.length > 2);
    const awayWords = normalise(ev.awayTeam.name).split(' ').filter(w => w.length > 2);
    const homeHit = homeWords.some(w => words.includes(w));
    const awayHit = awayWords.some(w => words.includes(w));
    return homeHit && awayHit;
  });
}

// Find an event from a matchup string like "Man City vs Arsenal"
function findEventByMatchup(events, matchup) {
  const parts = matchup.split(/\s+vs\.?\s+/i);
  if (parts.length !== 2) return null;
  const [home, away] = parts.map(s => s.trim());
  const nowSec = Date.now() / 1000;
  const upcoming = events
    .filter(ev => !ev.scheduled || ev.scheduled >= nowSec)
    .sort((a, b) => (a.scheduled || 0) - (b.scheduled || 0));
  return upcoming.find(ev =>
    teamMatch(home, ev.homeTeam.name) && teamMatch(away, ev.awayTeam.name)
  ) || upcoming.find(ev =>
    // also try reversed (some books list away first)
    teamMatch(away, ev.homeTeam.name) && teamMatch(home, ev.awayTeam.name)
  );
}

// Convert a feed event into the parse-fixture response shape
function eventToFixtureResponse(ev) {
  const markets = [];
  for (const [mktId, outcomes] of Object.entries(ev.markets)) {
    const mktName = MARKET_NAMES[mktId];
    if (!mktName) continue;
    for (const [outcomeId, odds] of Object.entries(outcomes)) {
      let selection;
      if (outcomeId === '1' || outcomeId === '4') selection = ev.homeTeam.name;
      else if (outcomeId === '3' || outcomeId === '5') selection = ev.awayTeam.name;
      else selection = GENERIC_OUTCOME_NAMES[outcomeId] || `Outcome ${outcomeId}`;
      markets.push({ marketName: mktName, selection, odds });
    }
  }
  return {
    sport:       ev.sport?.name || 'Unknown',
    competition: ev.tournament?.name || ev.category?.name || 'Unknown',
    fixture:     `${ev.homeTeam.name} vs ${ev.awayTeam.name}`,
    kickoff:     ev.scheduled ? new Date(ev.scheduled * 1000).toISOString() : null,
    markets,
    source:      'betby-feed',
    eventId:     ev.id,
  };
}

// Get platform odds for a given matchup + selection (used by analyse.js)
function getPlatformOdds(ev, selection) {
  if (!ev) return null;
  const s = normalise(selection);
  const home = normalise(ev.homeTeam.name);
  const away = normalise(ev.awayTeam.name);

  // Determine which outcome ID the selection maps to
  let outcomeId = null;
  if (s.includes('draw') || s === 'x') outcomeId = '2';
  else if (teamMatch(selection, ev.homeTeam.name) || home.split(' ').some(w => w.length > 3 && s.includes(w))) outcomeId = '1';
  else if (teamMatch(selection, ev.awayTeam.name) || away.split(' ').some(w => w.length > 3 && s.includes(w))) outcomeId = '3';

  // Try 1x2 first (market 1), then fallback markets
  const marketOrder = ['1', '186', '219', '251', '340', '406', '11'];
  for (const mktId of marketOrder) {
    const mkt = ev.markets[mktId];
    if (!mkt) continue;
    if (outcomeId && mkt[outcomeId] != null) {
      return { market: MARKET_NAMES[mktId], odds: mkt[outcomeId], outcomeId };
    }
    // If we couldn't determine outcome, return all outcomes for this market
    if (!outcomeId && Object.keys(mkt).length > 0) {
      const all = Object.entries(mkt).map(([id, o]) => ({
        outcomeId: id,
        name: id === '1' || id === '4' ? ev.homeTeam.name
             : id === '3' || id === '5' ? ev.awayTeam.name
             : GENERIC_OUTCOME_NAMES[id] || `Outcome ${id}`,
        odds: o,
      }));
      return { market: MARKET_NAMES[mktId], all };
    }
  }
  return null;
}

// ── HTTP handler (GET /api/feed) ──────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const events = await getFeedEvents();
    return res.json({
      success:    true,
      cached:     _cache && (Date.now() - _cache.ts) < CACHE_TTL,
      eventCount: events.length,
      fetchedAt:  _cache ? new Date(_cache.ts).toISOString() : null,
      events,
    });
  } catch (err) {
    console.error('[feed] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// Named exports for use by other API files
module.exports.getFeedEvents      = getFeedEvents;
module.exports.findEventBySlug    = findEventBySlug;
module.exports.findEventByMatchup = findEventByMatchup;
module.exports.eventToFixtureResponse = eventToFixtureResponse;
module.exports.getPlatformOdds    = getPlatformOdds;
