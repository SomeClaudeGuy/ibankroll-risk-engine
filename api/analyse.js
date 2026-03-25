'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function extractText(content) {
  if (!Array.isArray(content)) return String(content);
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

function parseJSON(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in response');
  return JSON.parse(match[0]);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed.' });

  try {
    const { matchup, selection, odds, wager } = req.body;

    if (!matchup || !selection || !odds || !wager) {
      return res.status(400).json({ success: false, error: 'Fixture, selection, odds and wager are required.' });
    }

    const oddsNum  = parseFloat(odds);
    const wagerNum = parseFloat(wager);

    if (isNaN(oddsNum) || oddsNum < 1.01) return res.status(400).json({ success: false, error: 'Odds must be ≥ 1.01.' });
    if (isNaN(wagerNum) || wagerNum <= 0)  return res.status(400).json({ success: false, error: 'Wager must be > 0.' });

    const impliedProb = 1 / oddsNum;

    // Single combined call: web search + structured JSON analysis
    const prompt = `You are a senior sports trading analyst at a wholesale sportsbook. A client wants to place this bet:

Fixture:   ${matchup}
Selection: ${selection}
Odds:      ${oddsNum} (decimal)
Stake:     $${wagerNum.toLocaleString('en-US')}

STEP 1 — Search for the following (run 2 searches max):
1. "${matchup} ${selection} odds Pinnacle Bet365 DraftKings" — live market prices
2. "${matchup} form head to head injuries" — recent form, H2H, team news

STEP 2 — Using what you found, produce a complete commercial risk assessment.

You must determine:
- Sport and market type (from fixture + selection)
- OFFLOAD % — how much of this risk to lay off to our iBankroll wholesale partner.
  Sharp/large/risky bet = offload more (60–85%). Soft/recreational = retain more (20–50%).
- MARGIN % — our profit margin on the iBankroll wholesale price.
  Liquid markets (NBA ML, EPL 1X2): 3–5%. Niche/props/parlays: 5–10%.

Then calculate:
  ibOdds   = ${oddsNum} × (1 − margin/100)
  retained = ${wagerNum} × (1 − offload/100)
  offloaded= ${wagerNum} × (offload/100)
  netWin   = offloaded × (ibOdds − 1) − ${wagerNum} × (${oddsNum} − 1) + ${wagerNum}
  netLose  = retained
  ev       = ${impliedProb.toFixed(6)} × netWin − ${(1 - impliedProb).toFixed(6)} × retained

For aiAnalysis write exactly 4 paragraphs (separated by \\n\\n):
  1. Market overview and where client's odds sit vs consensus
  2. Form, H2H and statistical case for/against
  3. Sharp action, line movement, public vs smart money
  4. Commercial verdict — how to position, margin justification, key risks

STEP 3 — Respond ONLY with this JSON object. No markdown fences. No text before or after.

{
  "detectedSport": "string",
  "detectedMarket": "string",
  "recommendedOffload": integer,
  "recommendedMargin": number,
  "ibOdds": number,
  "retained": number,
  "offloaded": number,
  "netWin": number,
  "netLose": number,
  "ev": number,
  "verdict": "TAKE" | "LEAN_TAKE" | "LEAN_PASS" | "PASS",
  "verdictReason": "string max 25 words",
  "riskScore": integer 1–100,
  "riskLabel": "Low" | "Moderate" | "High" | "Very High",
  "fairOdds": number,
  "impliedProb": number,
  "marketOdds": [
    {"book":"Pinnacle","price":number},
    {"book":"Bet365","price":number},
    {"book":"DraftKings","price":number},
    {"book":"FanDuel","price":number},
    {"book":"PointsBet","price":number}
  ],
  "optimalOffload": integer,
  "suggestedMaxWager": number,
  "edgeVsMarket": number,
  "kellyFraction": number,
  "clv": number,
  "recentForm": "string",
  "lineMovement": "string",
  "keyRisks": "string",
  "aiAnalysis": "para1\\n\\npara2\\n\\npara3\\n\\npara4",
  "breakEvenProb": number,
  "sharpAction": "string",
  "publicVsSharp": "string",
  "weatherInjuries": "string",
  "scenarios": [
    {"label":"Best case","pnl":number,"desc":"string"},
    {"label":"Base case","pnl":number,"desc":"string"},
    {"label":"Worst case","pnl":number,"desc":"string"}
  ]
}`;

    console.log(`[analyse] Single-call analysis: ${matchup} / ${selection}`);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    });

    console.log(`[analyse] Done. stop_reason=${response.stop_reason}`);

    const rawText = extractText(response.content);

    let data;
    try {
      data = parseJSON(rawText);
    } catch (e) {
      console.error('[analyse] JSON parse error:', e.message);
      console.error('[analyse] Raw (500 chars):', rawText.slice(0, 500));
      return res.status(500).json({ success: false, error: 'Model returned invalid JSON. Please try again.' });
    }

    data.inputOdds  = oddsNum;
    data.inputWager = wagerNum;

    return res.json({ success: true, data });

  } catch (err) {
    console.error('[analyse] Error:', err);
    if (err.status === 401) return res.status(500).json({ success: false, error: 'Invalid Anthropic API key. Add ANTHROPIC_API_KEY in Vercel environment variables.' });
    if (err.status === 429) return res.status(429).json({ success: false, error: 'Rate limit reached. Please wait a moment and try again.' });
    return res.status(500).json({ success: false, error: err.message || 'Internal server error.' });
  }
};
