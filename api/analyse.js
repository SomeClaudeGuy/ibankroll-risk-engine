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

    const prompt = `You are a senior sports trading analyst at a wholesale sportsbook with 15 years of experience. A client has placed the following bet and you must produce a complete commercial risk assessment using your expert knowledge.

FIXTURE:   ${matchup}
SELECTION: ${selection}
CLIENT ODDS (decimal): ${oddsNum}
STAKE:     $${wagerNum.toLocaleString('en-US')}
IMPLIED PROBABILITY: ${(impliedProb * 100).toFixed(2)}%

YOUR TASK — using your deep knowledge of this sport, competition, teams/players, and betting markets:

1. IDENTIFY sport, competition, and market type from the fixture and selection.

2. ASSESS the bet:
   - Estimate what the true fair odds should be for this selection
   - Estimate current prices at Pinnacle, Bet365, DraftKings, FanDuel, PointsBet
   - Analyse recent form, head-to-head record, and key statistics for both sides
   - Identify whether this looks like sharp or recreational money
   - Note any well-known injuries, suspensions, or contextual factors

3. DETERMINE commercial parameters:
   OFFLOAD % — how much risk to lay off to our iBankroll wholesale partner:
     - Sharp / large stake / high variance = offload 60–85%
     - Soft / recreational / low variance = offload 20–50%
   MARGIN % — our profit margin on the iBankroll wholesale price:
     - Liquid mainstream markets (NBA ML, EPL 1X2, spreads): 3–5%
     - Player props, correct score, parlays, niche markets: 5–10%

4. CALCULATE using your chosen offload % and margin %:
   ibOdds   = ${oddsNum} × (1 − margin/100)
   retained = ${wagerNum} × (1 − offload/100)
   offloaded= ${wagerNum} × (offload/100)
   netWin   = offloaded × (ibOdds − 1) − ${wagerNum} × (${oddsNum} − 1) + ${wagerNum}
   netLose  = retained
   ev       = ${impliedProb.toFixed(6)} × netWin − ${(1 - impliedProb).toFixed(6)} × retained

5. WRITE aiAnalysis as exactly 4 paragraphs (double newline between each):
   § 1 — Market overview: where do these odds sit vs the consensus? Is the client getting value or giving it away?
   § 2 — Form & statistics: what do the numbers say? Recent results, H2H, home/away, motivation.
   § 3 — Sharp money & line context: does this look like a sharp play? Where would you expect the line to be and why?
   § 4 — Commercial verdict: how should we position this on our book, what margin is justified, what keeps you up at night about this bet?

Respond ONLY with the following JSON. No markdown. No text before or after. No comments.

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
  "riskScore": integer 1-100,
  "riskLabel": "Low" | "Moderate" | "High" | "Very High",
  "fairOdds": number,
  "impliedProb": number,
  "marketOdds": [
    {"book": "Pinnacle",   "price": number},
    {"book": "Bet365",     "price": number},
    {"book": "DraftKings", "price": number},
    {"book": "FanDuel",    "price": number},
    {"book": "PointsBet",  "price": number}
  ],
  "optimalOffload": integer,
  "suggestedMaxWager": number,
  "edgeVsMarket": number,
  "kellyFraction": number,
  "clv": number,
  "recentForm": "2-3 sentences on both sides recent form and H2H",
  "lineMovement": "1-2 sentences on expected line movement and why",
  "keyRisks": "2-3 specific risks to our book position",
  "aiAnalysis": "paragraph 1\\n\\nparagraph 2\\n\\nparagraph 3\\n\\nparagraph 4",
  "breakEvenProb": number,
  "sharpAction": "string",
  "publicVsSharp": "string",
  "weatherInjuries": "string",
  "scenarios": [
    {"label": "Best case",  "pnl": number, "desc": "string"},
    {"label": "Base case",  "pnl": number, "desc": "string"},
    {"label": "Worst case", "pnl": number, "desc": "string"}
  ]
}`;

    console.log(`[analyse] ${matchup} / ${selection} @ ${oddsNum}`);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = extractText(response.content);
    console.log(`[analyse] Done. stop_reason=${response.stop_reason}`);

    let data;
    try {
      data = parseJSON(rawText);
    } catch (e) {
      console.error('[analyse] JSON parse error:', e.message);
      console.error('[analyse] Raw:', rawText.slice(0, 500));
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
