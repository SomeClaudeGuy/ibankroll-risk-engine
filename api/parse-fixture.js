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

    // Extract any useful slug info from the URL to help guide search
    const urlSlug = parsedUrl.pathname.replace(/[^a-z0-9-]/gi, ' ').trim();

    const prompt = `You are a sports data extraction specialist. Use ONE focused web search to find the betting markets for this sportsbook event.

URL: ${url}
URL slug hints: ${urlSlug}

Do a single search using the most identifying terms from the URL slug (team names, sport, league). Find the fixture and its current odds.

Respond ONLY with a valid JSON object — no markdown, no extra text:

{
  "fixture": "Team A vs Team B",
  "sport": "NBA",
  "competition": "NBA Regular Season",
  "kickoff": "string or null",
  "markets": [
    { "marketName": "Moneyline", "selection": "Team A", "odds": 1.75 },
    { "marketName": "Moneyline", "selection": "Team B", "odds": 2.15 },
    { "marketName": "Spread (-5.5)", "selection": "Team A -5.5", "odds": 1.91 },
    { "marketName": "Spread (+5.5)", "selection": "Team B +5.5", "odds": 1.91 },
    { "marketName": "Total Over 224.5", "selection": "Over 224.5", "odds": 1.91 },
    { "marketName": "Total Under 224.5", "selection": "Under 224.5", "odds": 1.91 }
  ]
}

Include moneylines, spreads, totals and any player props you find. Use decimal odds. If exact odds aren't found, use realistic current market estimates.`;

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
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
