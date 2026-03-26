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

    const prompt = `You are a senior bookmaker and sports trader with 15 years of wholesale OTC experience. We are a sportsbook that has received a large client bet. We use iBankroll as a bankroll management partner — they absorb a portion of the liability we cannot fully cover ourselves.

━━━ BET RECEIVED FROM CLIENT ━━━
Fixture:            ${matchup}
Selection:          ${selection}
Client's odds:      ${oddsNum} (decimal)
Client's stake:     $${wagerNum.toLocaleString('en-US')}
Client's implied P: ${(impliedProb * 100).toFixed(2)}%
Max payout:         $${(oddsNum * wagerNum).toLocaleString('en-US', {maximumFractionDigits:2})}

━━━ HOW THE LIABILITY SPLIT WORKS ━━━
We split the liability with iBankroll. Both parties accept the same client odds.
  → We RETAIN a portion on our own book.
  → We PASS the rest to iBankroll — their liability, their share of the profit or loss.
  → There is NO commission or margin. The profit comes purely from the customer LOSING.

If customer LOSES: we keep our retained stake. iBankroll keeps theirs. We both profit.
If customer WINS:  we pay out profit on our retained share. iBankroll pays out theirs.

━━━ YOUR TASKS ━━━

1. IDENTIFY: sport, competition, market type.

2. ASSESS THE SELECTION using your expert knowledge:
   - What is the true fair probability of this selection winning?
   - What do major books price this at? (Pinnacle, Bet365, DraftKings, FanDuel, PointsBet)
   - Recent form, H2H record, key matchup factors
   - Is this sharp money or recreational? Would a sharp bettor back this?

3. RECOMMEND an OFFLOAD % to iBankroll:
   High offload (60–85%): sharp bet, large stake vs our capacity, high-variance event
   Low offload (20–50%): soft/recreational bet, low variance, we have confidence in the price

4. CALCULATE (use exact arithmetic, set recommendedMargin to 0):
   retained  = ${wagerNum} × (1 − offload/100)      ← our share of the stake
   offloaded = ${wagerNum} × (offload/100)           ← iBankroll's share
   ibOdds    = ${oddsNum}                            ← same odds for both parties
   netLose   = retained                              ← our PROFIT when customer LOSES
   netWin    = −(retained × (${oddsNum}−1))          ← our LOSS when customer WINS
   ev        = (1−fairWinProb)×retained + fairWinProb×netWin
   ibBreakEven = 1/${oddsNum} = ${impliedProb.toFixed(4)}  ← client implied probability

   KEY INSIGHT: if true win prob < ${impliedProb.toFixed(4)} (implied) → we have edge → TAKE
                if true win prob > ${impliedProb.toFixed(4)} → customer has value → PASS

5. VERDICT logic:
   TAKE      → true win prob clearly below implied probability
   LEAN_TAKE → close call, slight edge for us, manageable risk with offload
   LEAN_PASS → customer likely has value, or stake too large even with offload
   PASS      → true win prob above implied probability — customer has clear edge

6. WRITE aiAnalysis: exactly 4 paragraphs (separated by \\n\\n):
   § 1 — ODDS ASSESSMENT: where is the client's price vs. fair value and market consensus? Are they getting value (bad for us) or getting a bad price (good for us)?
   § 2 — FORM & STATISTICS: what does recent form, H2H and stats say about the true probability? Back your fair odds estimate.
   § 3 — SHARP MONEY PROFILE: does this look like a sharp or recreational bet? How should that affect the offload % recommendation?
   § 4 — TRADING DECISION: our implied break-even, EV, and exact recommendation on offload % and max retained stake.

Respond ONLY with the following JSON. No markdown. No text before or after. No comments.

{
  "detectedSport": "string",
  "detectedMarket": "string",
  "recommendedOffload": integer,
  "recommendedMargin": 0,
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
