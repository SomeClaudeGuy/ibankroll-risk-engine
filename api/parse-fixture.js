'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function extractText(content) {
  if (!Array.isArray(content)) return String(content);
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

function parseJSON(raw) {
  const stripped = raw.replace(/```[\w]*\n?/g, '').trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON found');
  return JSON.parse(match[0]);
}

async function withRetry(fn, retries = 2, delayMs = 3000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err.status === 429 || (err.message || '').includes('rate');
      if (is429 && attempt < retries) {
        console.log(`[parse-fixture] Rate limited - retrying in ${delayMs}ms (attempt ${attempt + 1}/${retries})`);
        await new Promise(r => setTimeout(r, delayMs));
        delayMs *= 2;
      } else {
        throw err;
      }
    }
  }
}

const LEAGUE_MAP = [
  { keys: ['nba'],                        label: 'NBA',               sport: 'NBA' },
  { keys: ['nfl'],                        label: 'NFL',               sport: 'NFL' },
  { keys: ['nhl'],                        label: 'NHL',               sport: 'NHL' },
  { keys: ['mlb'],                        label: 'MLB',               sport: 'MLB' },
  { keys: ['ncaab','college-basketball'], label: 'NCAA Basketball',   sport: 'NCAAB' },
  { keys: ['ncaaf','college-football'],   label: 'NCAA Football',     sport: 'NCAAF' },
  { keys: ['ufc','mma'],                  label: 'UFC / MMA',         sport: 'MMA/UFC' },
  { keys: ['premier-league','epl'],       label: 'Premier League',    sport: 'EPL' },
  { keys: ['la-liga','laliga'],           label: 'La Liga',           sport: 'La Liga' },
  { keys: ['bundesliga'],                 label: 'Bundesliga',        sport: 'Bundesliga' },
  { keys: ['serie-a'],                    label: 'Serie A',           sport: 'Serie A' },
  { keys: ['ligue-1'],                    label: 'Ligue 1',           sport: 'Ligue 1' },
  { keys: ['champions-league','ucl'],     label: 'Champions League',  sport: 'UCL' },
  { keys: ['europa-league'],              label: 'Europa League',     sport: 'UEL' },
  { keys: ['tennis'],                     label: 'Tennis',            sport: 'Tennis' },
  { keys: ['basketball'],                 label: 'Basketball',        sport: 'Basketball' },
  { keys: ['soccer','football'],          label: 'Soccer',            sport: 'Soccer' },
  { keys: ['hockey','ice-hockey'],        label: 'Hockey',            sport: 'Hockey' },
  { keys: ['baseball'],                   label: 'Baseball',          sport: 'Baseball' },
  { keys: ['boxing'],                     label: 'Boxing',            sport: 'Boxing' },
];

function detectLeague(path) {
  const lower = path.toLowerCase();
  return LEAGUE_MAP.find(e => e.keys.some(k => lower.includes(k))) || null;
}

/**
 * Given the last URL path segment (e.g. "boston-celtics-oklahoma-city-thunder-2648126436443041833"),
 * strip trailing pure-numeric IDs and return a human-readable slug.
 * Returns null if what's left is just a league/sport name (≤ 2 words).
 */
function extractFixtureSlug(segment) {
  const cleaned = segment.replace(/-?\d{8,}$/, '').replace(/-$/, '').trim();
  const words = cleaned.split('-').filter(Boolean);
  return words.length >= 3 ? words.join(' ') : null;
}

/**
 * Try to fetch the sportsbook page directly and extract odds from the HTML/JSON.
 * Many SPAs embed initial state in <script> tags or return JSON from API endpoints.
 * Returns parsed fixture data or null if scraping fails.
 */
async function scrapePageOdds(url, rawUrl) {
  try {
    // 1. Try fetching the page HTML
    const pageRes = await fetch(rawUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!pageRes.ok) return null;
    const html = await pageRes.text();

    // Trim to a reasonable size to avoid huge token counts
    const trimmed = html.slice(0, 40000);

    // 2. Ask Claude to extract the odds from the raw HTML - no web search needed
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Extract betting fixture and odds from this sportsbook page HTML. The page is from: ${rawUrl}

Look for team names, match status (pre-match or live), and all available markets/odds in the HTML content below.

HTML:
${trimmed}

Return ONLY valid JSON - no markdown:
{
  "fixture": "Team A vs Team B",
  "sport": "string",
  "competition": "string",
  "isLive": true | false,
  "kickoff": "date/time or null",
  "markets": [
    { "marketName": "1x2", "selection": "Team A", "odds": 1.65 },
    { "marketName": "1x2", "selection": "Draw", "odds": 3.70 },
    { "marketName": "1x2", "selection": "Team B", "odds": 4.70 }
  ]
}

Include ALL markets and selections you can find. If no odds are found in the HTML (JS-rendered page), return null.`,
      }],
    });

    const raw = extractText(response.content);
    if (raw.trim() === 'null' || !raw.includes('{')) return null;
    const data = parseJSON(raw);
    if (!data?.fixture || !data?.markets?.length) return null;
    return data;

  } catch (err) {
    console.log('[parse-fixture] Direct scrape failed:', err.message);
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed.' });

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ success: false, error: 'A URL is required.' });

  let parsedUrl;
  try { parsedUrl = new URL(url); }
  catch { return res.status(400).json({ success: false, error: 'Invalid URL.' }); }

  const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
  const lastSegment  = pathSegments[pathSegments.length - 1] || '';
  const fixtureSlug  = extractFixtureSlug(lastSegment);
  const league       = detectLeague(parsedUrl.pathname);

  // ── Mode A: URL contains team names ────────────────────────────────────────
  // e.g. /nba/boston-celtics-oklahoma-city-thunder-2648126436443041833
  if (fixtureSlug) {
    console.log(`[parse-fixture] Mode A - fixture slug: "${fixtureSlug}"`);

    const prompt = `You are a sports data specialist. Search for the current betting odds for this fixture.

Fixture slug from URL: "${fixtureSlug}"
League: ${league?.label || 'unknown'}

Search for: "${fixtureSlug} odds betting ${league?.label || ''}"

Identify the two teams/players from the slug and find their current odds on this specific matchup.

Respond ONLY with valid JSON - no markdown, no extra text:

{
  "fixture": "Team A vs Team B",
  "sport": "${league?.sport || 'Unknown'}",
  "competition": "league name",
  "kickoff": "date/time string or null",
  "markets": [
    { "marketName": "Moneyline", "selection": "Team A", "odds": 1.75 },
    { "marketName": "Moneyline", "selection": "Team B", "odds": 2.15 },
    { "marketName": "Spread (-3.5)", "selection": "Team A -3.5", "odds": 1.91 },
    { "marketName": "Spread (+3.5)", "selection": "Team B +3.5", "odds": 1.91 },
    { "marketName": "Total Over 224.5", "selection": "Over 224.5", "odds": 1.91 },
    { "marketName": "Total Under 224.5", "selection": "Under 224.5", "odds": 1.91 }
  ]
}

Include all available markets. Use decimal odds throughout.`;

    try {
      const response = await withRetry(() => client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }],
      }));

      const raw = extractText(response.content);
      const data = parseJSON(raw);

      if (!data.fixture || !data.markets?.length) {
        throw new Error('Incomplete fixture data');
      }

      return res.json({
        success: true,
        mode: 'single',
        data: {
          sport: data.sport,
          competition: data.competition,
          fixture: data.fixture,
          kickoff: data.kickoff || null,
          markets: data.markets,
        },
      });

    } catch (err) {
      if (err.status === 429) {
        return res.status(429).json({ success: false, error: 'Rate limit reached - please wait 10 seconds and try again.' });
      }
      console.error('[parse-fixture] Mode A failed:', err.message, '- falling back to Mode B');
      // Fall through to Mode B
    }
  }

  // ── Mode B: URL has no team names - search for upcoming league fixtures ────
  // e.g. /sports/basketball/usa/nba-1669819088278523904
  const leagueLabel = league?.label || 'sports';
  console.log(`[parse-fixture] Mode B - league: "${leagueLabel}"`);

  const prompt = `You are a sports data specialist. Search for upcoming ${leagueLabel} fixtures with betting odds.

Search for: "upcoming ${leagueLabel} games odds today this week"

Return as many upcoming fixtures as you can find (aim for 6-10).

Respond ONLY with valid JSON - no markdown, no extra text:

{
  "sport": "${league?.sport || 'Unknown'}",
  "competition": "${leagueLabel}",
  "fixtures": [
    {
      "fixture": "Team A vs Team B",
      "kickoff": "date/time or null",
      "markets": [
        { "marketName": "Moneyline", "selection": "Team A", "odds": 1.75 },
        { "marketName": "Moneyline", "selection": "Team B", "odds": 2.15 },
        { "marketName": "Spread (-3.5)", "selection": "Team A -3.5", "odds": 1.91 },
        { "marketName": "Spread (+3.5)", "selection": "Team B +3.5", "odds": 1.91 },
        { "marketName": "Total Over 224.5", "selection": "Over 224.5", "odds": 1.91 },
        { "marketName": "Total Under 224.5", "selection": "Under 224.5", "odds": 1.91 }
      ]
    }
  ]
}`;

  try {
    const response = await withRetry(() => client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    }));

    const raw = extractText(response.content);
    const data = parseJSON(raw);

    if (!data.fixtures?.length) {
      return res.status(422).json({
        success: false,
        error: `No upcoming fixtures found for ${leagueLabel}. Try entering details manually.`,
      });
    }

    return res.json({ success: true, data });

  } catch (err) {
    console.error('[parse-fixture] Mode B error:', err);
    if (err.status === 401) return res.status(500).json({ success: false, error: 'Invalid API key.' });
    if (err.status === 429) return res.status(429).json({ success: false, error: 'Rate limit reached. Please wait and try again.' });
    return res.status(500).json({
      success: false,
      error: `Could not find fixtures for ${leagueLabel}. Try entering details manually.`,
    });
  }
};
