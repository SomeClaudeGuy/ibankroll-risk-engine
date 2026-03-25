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

  try {
    const { matchup, selection, odds, wager } = req.body;

    if (!matchup || !selection || !odds || !wager) {
      return res.status(400).json({ success: false, error: 'Fixture, selection, odds and wager are required.' });
    }

    const oddsNum  = parseFloat(odds);
    const wagerNum = parseFloat(wager);

    if (isNaN(oddsNum) || oddsNum < 1.01) return res.status(400).json({ success: false, error: 'Odds must be ≥ 1.01.' });
    if (isNaN(wagerNum) || wagerNum <= 0)  return res.status(400).json({ success: false, error: 'Wager must be > 0.' });

    // ── Phase 1: Web search ──────────────────────────────────────────────────
    const searchPrompt = `You are a professional sports trading analyst. Research this bet using web search.

FIXTURE:   ${matchup}
SELECTION: ${selection}
ODDS:      ${oddsNum}

Run the following searches:
1. "${matchup} odds ${selection}" — find current live prices from Pinnacle, Bet365, DraftKings, FanDuel
2. "${matchup} preview form statistics head to head" — recent form, H2H, key stats
3. "${matchup} betting line movement sharp money" — line movement and sharp action
4. "${matchup} team news injuries ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}" — latest team/injury news

Gather everything. I will use it for a full risk analysis.`;

    console.log(`[analyse] Searching: ${matchup} / ${selection}`);

    const searchResponse = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8096,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: searchPrompt }],
    });

    const searchResults = extractText(searchResponse.content);
    console.log(`[analyse] Search done.`);

    // ── Phase 2: Full analysis ───────────────────────────────────────────────
    const impliedProb = 1 / oddsNum;

    const analysisPrompt = `You are a senior sports trading analyst at a wholesale sportsbook. A client wants to place a bet and you must decide how to position it on our book.

You will determine ALL commercial parameters — the client only tells us the fixture, selection, odds, and stake.

═══════════════════════════════════════════
BET RECEIVED
═══════════════════════════════════════════
Fixture:          ${matchup}
Selection:        ${selection}
Client's Odds:    ${oddsNum} (decimal)
Stake:            $${wagerNum.toLocaleString('en-US')}
Implied Prob:     ${(impliedProb * 100).toFixed(2)}%

═══════════════════════════════════════════
WEB SEARCH DATA
═══════════════════════════════════════════
${searchResults}

═══════════════════════════════════════════
YOUR JOB
═══════════════════════════════════════════
Using the search data above, produce a complete commercial risk assessment. You must determine:

1. SPORT & MARKET — identify from the fixture and selection
2. OFFLOAD % — what % of this risk we should lay off to our iBankroll wholesale partner.
   Logic: high risk / sharp bet / large stake vs market = offload more (60-85%).
   Recreational / soft bet / favourable odds for us = retain more (20-50%).
   Range: 0-100.
3. MARGIN % — our profit margin on the iBankroll wholesale price.
   Liquid mainstream markets (EPL 1X2, NBA ML): 3-5%.
   Niche/prop/accas: 5-10%.
   Very sharp or uncertain: up to 12%.

Based on your recommended offload % and margin %, calculate:
  ibOdds    = ${oddsNum} × (1 - margin/100)
  retained  = ${wagerNum} × (1 - offload/100)
  offloaded = ${wagerNum} × (offload/100)
  netWin    = offloaded × (ibOdds - 1) - ${wagerNum} × (${oddsNum} - 1) + ${wagerNum}
  netLose   = retained
  ev        = (${impliedProb.toFixed(6)}) × netWin - (${(1 - impliedProb).toFixed(6)}) × retained

For scenarios:
  Best case pnl  = netWin (bet wins, our position is positive)
  Base case pnl  = EV
  Worst case pnl = −retained (bet wins and it's our worst outcome, or bet loses and we're fully exposed)

For aiAnalysis: exactly 4 paragraphs separated by \\n\\n:
  (1) Market overview — where is the consensus, is the client's price fair, over, or under market?
  (2) Form & statistics — what do the numbers say about likely outcome?
  (3) Sharp action & line movement — is this a sharp or public bet? Where is the smart money?
  (4) Commercial verdict — how should we position this, what margin is justified, key risks to our book?

Respond ONLY with a valid JSON object. No markdown fences. No extra text. No comments.

{
  "detectedSport": "string",
  "detectedMarket": "string",
  "recommendedOffload": integer 0-100,
  "recommendedMargin": number,
  "ibOdds": number,
  "retained": number,
  "offloaded": number,
  "netWin": number,
  "netLose": number,
  "ev": number,
  "verdict": "TAKE" | "LEAN_TAKE" | "LEAN_PASS" | "PASS",
  "verdictReason": "string max 25 words",
  "riskScore": integer 1-100,
  "riskLabel": "Low" | "Moderate" | "High" | "Very High",
  "fairOdds": number,
  "impliedProb": number,
  "marketOdds": [
    {"book": "Pinnacle", "price": number},
    {"book": "Bet365", "price": number},
    {"book": "DraftKings", "price": number},
    {"book": "FanDuel", "price": number},
    {"book": "PointsBet", "price": number}
  ],
  "optimalOffload": integer,
  "suggestedMaxWager": number,
  "edgeVsMarket": number,
  "kellyFraction": number,
  "clv": number,
  "recentForm": "string",
  "lineMovement": "string",
  "keyRisks": "string",
  "aiAnalysis": "paragraph1\\n\\nparagraph2\\n\\nparagraph3\\n\\nparagraph4",
  "breakEvenProb": number,
  "sharpAction": "string",
  "publicVsSharp": "string",
  "weatherInjuries": "string",
  "scenarios": [
    {"label": "Best case", "pnl": number, "desc": "string"},
    {"label": "Base case", "pnl": number, "desc": "string"},
    {"label": "Worst case", "pnl": number, "desc": "string"}
  ]
}`;

    console.log(`[analyse] Running analysis...`);

    const analysisResponse = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: analysisPrompt }],
    });

    const rawJSON = extractText(analysisResponse.content);

    let data;
    try {
      data = parseJSON(rawJSON);
    } catch (e) {
      console.error('[analyse] JSON parse error:', e.message);
      console.error('[analyse] Raw (500 chars):', rawJSON.slice(0, 500));
      return res.status(500).json({ success: false, error: 'Model returned invalid JSON. Please try again.' });
    }

    // Attach input context for the frontend
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
