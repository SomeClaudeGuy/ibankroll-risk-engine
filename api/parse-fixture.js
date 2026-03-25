'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function extractText(content) {
  if (!Array.isArray(content)) return String(content);
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

function parseJSON(raw) {
  return JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed.' });

  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'A URL is required.' });
  }

  // Basic URL validation
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ success: false, error: 'Invalid URL.' });
  }

  try {
    console.log(`[parse-fixture] Fetching: ${url}`);

    const prompt = `You are a sports data extraction specialist. Use web search to browse this sportsbook URL and extract all available betting markets and odds:

URL: ${url}

Browse the page and identify:
1. The fixture (which two teams/players are competing)
2. The sport and competition/league
3. The scheduled kickoff/start time if visible
4. ALL available betting markets with their current decimal odds

If the page requires login or isn't accessible, search for the fixture using any identifiers from the URL (sport, league, event ID, team names) to find the current odds on this event.

Respond ONLY with a valid JSON object — no markdown, no extra text:

{
  "fixture": "Team A vs Team B",
  "sport": "NBA",
  "competition": "NBA Regular Season",
  "kickoff": "string or null",
  "markets": [
    {
      "marketName": "Moneyline",
      "selection": "Team A",
      "odds": 1.75
    },
    {
      "marketName": "Moneyline",
      "selection": "Team B",
      "odds": 2.15
    },
    {
      "marketName": "Spread (-5.5)",
      "selection": "Team A -5.5",
      "odds": 1.91
    },
    {
      "marketName": "Spread (+5.5)",
      "selection": "Team B +5.5",
      "odds": 1.91
    },
    {
      "marketName": "Total Over 224.5",
      "selection": "Over 224.5",
      "odds": 1.91
    },
    {
      "marketName": "Total Under 224.5",
      "selection": "Under 224.5",
      "odds": 1.91
    }
  ]
}

Include as many markets as you can find: moneylines, spreads/handicaps, totals, player props, 1X2, BTTS, etc. Use decimal odds throughout. If you cannot find exact odds, provide realistic estimates based on current market knowledge and note them as estimates.`;

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
      console.error('[parse-fixture] JSON parse error:', e.message);
      console.error('[parse-fixture] Raw:', raw.slice(0, 400));
      return res.status(500).json({ success: false, error: 'Could not extract fixture data from that URL. Try entering the details manually.' });
    }

    if (!data.fixture || !data.markets?.length) {
      return res.status(422).json({ success: false, error: 'No betting markets found at that URL. The page may require login — try entering details manually.' });
    }

    return res.json({ success: true, data });

  } catch (err) {
    console.error('[parse-fixture] Error:', err);
    if (err.status === 401) return res.status(500).json({ success: false, error: 'Invalid API key.' });
    if (err.status === 429) return res.status(429).json({ success: false, error: 'Rate limit reached. Please wait and try again.' });
    return res.status(500).json({ success: false, error: err.message || 'Failed to parse fixture.' });
  }
};
