'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function extractText(content) {
  if (!Array.isArray(content)) return String(content);
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

function parseJSON(raw) {
  // Try to extract JSON even if there's surrounding text
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found');
  return JSON.parse(match[0]);
}

// Map URL path keywords → searchable league names
const LEAGUE_MAP = [
  { keys: ['nba'],                      sport: 'NBA',         label: 'NBA' },
  { keys: ['nfl'],                      sport: 'NFL',         label: 'NFL' },
  { keys: ['nhl'],                      sport: 'NHL',         label: 'NHL' },
  { keys: ['mlb'],                      sport: 'MLB',         label: 'MLB' },
  { keys: ['ncaab', 'college-basketball'], sport: 'NCAAB',    label: 'NCAA Basketball' },
  { keys: ['ncaaf', 'college-football'],  sport: 'NCAAF',     label: 'NCAA Football' },
  { keys: ['ufc', 'mma'],              sport: 'MMA/UFC',     label: 'UFC / MMA' },
  { keys: ['premier-league', 'epl'],   sport: 'EPL',         label: 'Premier League' },
  { keys: ['la-liga', 'laliga'],       sport: 'La Liga',     label: 'La Liga' },
  { keys: ['bundesliga'],              sport: 'Bundesliga',  label: 'Bundesliga' },
  { keys: ['serie-a'],                 sport: 'Serie A',     label: 'Serie A' },
  { keys: ['ligue-1'],                 sport: 'Ligue 1',     label: 'Ligue 1' },
  { keys: ['champions-league', 'ucl'], sport: 'UCL',         label: 'Champions League' },
  { keys: ['europa-league'],           sport: 'UEL',         label: 'Europa League' },
  { keys: ['soccer', 'football'],      sport: 'Soccer',      label: 'Soccer' },
  { keys: ['tennis'],                  sport: 'Tennis',      label: 'Tennis' },
  { keys: ['basketball'],              sport: 'Basketball',  label: 'Basketball' },
  { keys: ['american-football'],       sport: 'American Football', label: 'American Football' },
  { keys: ['ice-hockey', 'hockey'],    sport: 'Hockey',      label: 'Hockey' },
  { keys: ['baseball'],                sport: 'Baseball',    label: 'Baseball' },
  { keys: ['boxing'],                  sport: 'Boxing',      label: 'Boxing' },
];

function detectLeague(urlPath) {
  const lower = urlPath.toLowerCase();
  for (const entry of LEAGUE_MAP) {
    if (entry.keys.some(k => lower.includes(k))) return entry;
  }
  return null;
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

  const league = detectLeague(parsedUrl.pathname);

  // If we can identify a league, search for upcoming fixtures in it.
  // This works regardless of whether the URL contains team names.
  const searchTarget = league
    ? `upcoming ${league.label} fixtures odds today this week`
    : `sports betting odds fixtures today`;

  console.log(`[parse-fixture] URL: ${url} → detected: ${league?.label || 'unknown'} → searching: "${searchTarget}"`);

  try {
    const prompt = `You are a sports data specialist. The user pasted this sportsbook URL:

${url}

The URL path is: ${parsedUrl.pathname}
Detected sport/league: ${league ? league.label : 'unknown — infer from URL'}

Step 1 — Search for: "${searchTarget}"
Find the upcoming or live fixtures in this sport/league along with their current betting odds.

Step 2 — Return a JSON object listing all fixtures you find. Include as many markets per fixture as possible.

Respond ONLY with valid JSON — no markdown, no extra text:

{
  "sport": "${league?.sport || 'Unknown'}",
  "competition": "league or competition name",
  "fixtures": [
    {
      "fixture": "Team A vs Team B",
      "kickoff": "e.g. Today 19:45 UTC or null",
      "markets": [
        { "marketName": "Moneyline", "selection": "Team A", "odds": 1.75 },
        { "marketName": "Moneyline", "selection": "Team B", "odds": 2.15 },
        { "marketName": "Draw", "selection": "Draw", "odds": 3.40 },
        { "marketName": "Spread (-3.5)", "selection": "Team A -3.5", "odds": 1.91 },
        { "marketName": "Total Over 224.5", "selection": "Over 224.5", "odds": 1.91 },
        { "marketName": "Total Under 224.5", "selection": "Under 224.5", "odds": 1.91 }
      ]
    }
  ]
}

List as many upcoming fixtures as you can find — aim for at least 4-8 games. More is better.`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = extractText(response.content);
    console.log(`[parse-fixture] Done. stop_reason=${response.stop_reason}`);

    let data;
    try {
      data = parseJSON(raw);
    } catch (e) {
      console.error('[parse-fixture] JSON parse error:', e.message, '\nRaw:', raw.slice(0, 400));
      return res.status(500).json({
        success: false,
        error: `Could not parse fixtures for ${league?.label || 'that sport'}. Try entering the details manually.`,
      });
    }

    if (!data.fixtures?.length) {
      return res.status(422).json({
        success: false,
        error: `No upcoming fixtures found for ${league?.label || 'that sport'}. Try entering the details manually.`,
      });
    }

    return res.json({ success: true, data });

  } catch (err) {
    console.error('[parse-fixture] Error:', err);
    if (err.status === 401) return res.status(500).json({ success: false, error: 'Invalid API key.' });
    if (err.status === 429) return res.status(429).json({ success: false, error: 'Rate limit reached. Please wait and try again.' });
    return res.status(500).json({ success: false, error: err.message || 'Failed to parse fixture.' });
  }
};
