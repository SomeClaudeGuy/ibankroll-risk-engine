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
    const { matchup, selection, odds, wager, lossback } = req.body;

    if (!matchup || !selection || !odds || !wager) {
      return res.status(400).json({ success: false, error: 'Fixture, selection, odds and wager are required.' });
    }

    const oddsNum     = parseFloat(odds);
    const wagerNum    = parseFloat(wager);
    const lossbackPct = Math.min(Math.max(parseFloat(lossback) || 0, 0), 15);

    if (isNaN(oddsNum) || oddsNum < 1.01) return res.status(400).json({ success: false, error: 'Odds must be ≥ 1.01.' });
    if (isNaN(wagerNum) || wagerNum <= 0)  return res.status(400).json({ success: false, error: 'Wager must be > 0.' });

    const impliedProb  = 1 / oddsNum;
    const lossbackAmt  = wagerNum * (lossbackPct / 100);

    const lossbackLine = lossbackPct > 0
      ? `Lossback %:         ${lossbackPct}% of stake = $${lossbackAmt.toLocaleString('en-US', {maximumFractionDigits:2})} (we refund this to client if they LOSE)`
      : `Lossback:           None`;

    const prompt = `You are a senior bookmaker and sports risk analyst. We are a growing sportsbook building our customer base. We use iBankroll as a bankroll management service — they allow us to take larger bets than our current float supports by absorbing a share of the liability.

━━━ BET RECEIVED FROM CLIENT ━━━
Fixture:            ${matchup}
Selection:          ${selection}
Client's odds:      ${oddsNum} (decimal)
Client's stake:     $${wagerNum.toLocaleString('en-US')}
Client's implied P: ${(impliedProb * 100).toFixed(2)}%
Gross payout (if win): $${(oddsNum * wagerNum).toLocaleString('en-US', {maximumFractionDigits:2})}
${lossbackLine}

━━━ THE IBANKROLL MODEL ━━━
We send a portion of the stake to iBankroll as a hedge at the SAME client odds.
  → RETAINED = our share of the stake (our profit if client loses, our risk if they win)
  → OFFLOADED = sent to iBankroll; they pay us back retained×odds if client wins

THE CORE TRADEOFF:
  More offload → LOWER profit if client loses, but LOWER risk if they win
  Less offload → HIGHER profit if client loses, but HIGHER risk if they win

We are offloading because we are early-stage and building float. This is temporary.
The goal is to retain as much as we safely can given our current bankroll capacity.

━━━ LOSSBACK EXPLAINED ━━━
If lossback > 0%: when the client LOSES, we give them back ${lossbackPct}% of their stake ($${lossbackAmt.toLocaleString('en-US', {maximumFractionDigits:2})}).
This is a direct cost that reduces our profit when the client loses.
It does NOT affect what we owe if the client wins.

━━━ YOUR TASKS ━━━

1. IDENTIFY: sport, competition, market type.

2. ASSESS the selection using expert knowledge:
   - True fair probability and what major books price this at (Pinnacle, Bet365, DraftKings, FanDuel, PointsBet)
   - Recent form, H2H, key matchup factors
   - Sharp money or recreational? Is this a punter with an edge?

3. RECOMMEND optimal OFFLOAD % to iBankroll using this scoring framework:

   MATCH RISK factors (push offload UP):
   - Coin-flip fixture (implied prob 45-55%) → high variance, +15-25% offload
   - Short odds / heavy favourite (implied prob >70%) → lower variance, −10% offload
   - High-profile / marquee event → sharp money likely, +10% offload
   - Late line movement toward selection → possible sharp edge, +15% offload
   - Injury news, weather uncertainty, playoff context → +10-20% offload

   STAKE SIZE factors:
   - $0–$5K stake: retain more (50-70%), this is normal action
   - $5K–$15K stake: balanced split (60-75% offload), meaningful exposure
   - $15K–$30K stake: offload heavily (70-85%), beyond typical book capacity
   - $30K+ stake: near-maximum offload (85-95%), protect the book

   BETTOR PROFILE factors:
   - Unknown/new bettor: +10% offload (no history)
   - Known recreational: −10% offload (soft money, keep the edge)
   - Known sharp or professional: +20% offload (respect the edge)

   Combine these factors for a single integer offload %. Explain your reasoning with the specific factors that drove your recommendation.

4. CALCULATE (use exact arithmetic, set recommendedMargin to 0):
   retained   = ${wagerNum} × (1 − offload/100)
   offloaded  = ${wagerNum} × (offload/100)
   lossback   = $${lossbackAmt.toLocaleString('en-US', {maximumFractionDigits:2})} (given above — fixed regardless of offload %)
   ibOdds     = ${oddsNum}   (same client odds)

   netLose    = retained − lossback            ← our actual PROFIT when client LOSES
   netWin     = −(retained × (${oddsNum}−1))   ← our NET LOSS when client WINS
   ev         = (1−fairWinProb)×netLose + fairWinProb×netWin
   breakEven  = (retained − lossback) / (retained×${oddsNum} − lossback)

   KEY: if true win prob < breakEven → EV positive → TAKE
        if true win prob > breakEven → EV negative → PASS

5. VERDICT:
   TAKE      → clear edge, EV positive, stake manageable even with lossback
   LEAN_TAKE → slight edge, acceptable risk, offload adequately protects us
   LEAN_PASS → thin edge or lossback erodes profit, consider higher offload %
   PASS      → no edge or stake too large even at max offload

6. WRITE aiAnalysis: exactly 3 short paragraphs (separated by \\n\\n):
   § 1 — MARKET: fair odds vs client price, sharp or recreational, line movement, injuries/news.
   § 2 — OFFLOAD LOGIC: why this specific offload % — stake size, match risk, bettor profile.
   § 3 — VERDICT: gross payout split (we pay $X / iBankroll $Y if wins), profit if loses, EV.

Respond ONLY with valid JSON. No markdown, no text outside the JSON.

{
  "detectedSport": "string",
  "detectedMarket": "string",
  "recommendedOffload": integer,
  "ibOdds": number,
  "retained": number,
  "offloaded": number,
  "netWin": number,
  "netLose": number,
  "ev": number,
  "verdict": "TAKE" | "LEAN_TAKE" | "LEAN_PASS" | "PASS",
  "verdictReason": "string max 20 words",
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
  "suggestedMaxWager": number,
  "edgeVsMarket": number,
  "aiAnalysis": "paragraph 1\\n\\nparagraph 2\\n\\nparagraph 3",
  "scenarios": [
    {"label": "Best case",  "pnl": number, "desc": "client LOSES — we keep $X profit"},
    {"label": "Base case",  "pnl": number, "desc": "EV-weighted outcome"},
    {"label": "Worst case", "pnl": number, "desc": "client WINS — we pay $X, iBankroll pays $Y"}
  ]
}`;

    console.log(`[analyse] ${matchup} / ${selection} @ ${oddsNum}`);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1400,
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

    data.inputOdds     = oddsNum;
    data.inputWager    = wagerNum;
    data.inputLossback = lossbackPct;

    return res.json({ success: true, data });

  } catch (err) {
    console.error('[analyse] Error:', err);
    if (err.status === 401) return res.status(500).json({ success: false, error: 'Invalid Anthropic API key. Add ANTHROPIC_API_KEY in Vercel environment variables.' });
    if (err.status === 429) return res.status(429).json({ success: false, error: 'Rate limit reached. Please wait a moment and try again.' });
    return res.status(500).json({ success: false, error: err.message || 'Internal server error.' });
  }
};
