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
  if (!match) throw new Error('No JSON object found in response');
  return JSON.parse(match[0]);
}

async function withRetry(fn, retries = 3, delayMs = 8000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err.status === 429 || (err.message || '').includes('rate');
      if (is429 && attempt < retries) {
        console.log(`[analyse] Rate limited - retrying in ${delayMs}ms (attempt ${attempt + 1}/${retries})`);
        await new Promise(r => setTimeout(r, delayMs));
        delayMs *= 2;
      } else {
        throw err;
      }
    }
  }
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
    const lossbackAmt = wagerNum * (lossbackPct / 100);

    if (isNaN(oddsNum) || oddsNum < 1.01) return res.status(400).json({ success: false, error: 'Odds must be >= 1.01.' });
    if (isNaN(wagerNum) || wagerNum <= 0)  return res.status(400).json({ success: false, error: 'Wager must be > 0.' });

    const impliedProb = 1 / oddsNum;
    console.log(`[analyse] ${matchup} / ${selection} @ ${oddsNum} / wager $${wagerNum}`);

    const prompt = `You are a senior sports trading analyst AND bookmaker risk manager with 15+ years of experience. Analyse this bet comprehensively.

FIXTURE:   ${matchup}
SELECTION: ${selection}
OUR PRICE: ${oddsNum} decimal (implied ${(impliedProb * 100).toFixed(1)}% win probability)
STAKE:     $${wagerNum.toLocaleString('en-US')}
LOSSBACK:  ${lossbackPct > 0 ? `${lossbackPct}% = $${lossbackAmt.toFixed(2)} refunded to client if they LOSE` : 'None'}

CONTEXT: We (the bookmaker) accepted this bet from a client. We can offload a portion to our OTC liability partner iBankroll at the SAME odds. iBankroll covers their share if the client wins; we cover ours. No margin - pure liability split.

YOUR JOB - analyse in full:

MARKET ASSESSMENT:
- Identify sport, competition, and market type
- Estimate TRUE fair odds for the selection (strip the vig)
- Estimate what Pinnacle, Bet365, DraftKings, FanDuel and PointsBet would price this at
- Is our price (${oddsNum}) value for the client or for us?
- Recent form, H2H, injuries/suspensions you know about for this fixture
- Sharp vs recreational bet assessment (sharp = market moved toward this, profitable bettor history, or our price is generous vs fair)
- Line movement signals

RISK & OFFLOAD CALCULATION:
Use these offload scoring guidelines:
- Base by stake: <$5k=0-15%, $5-15k=20-40%, $15-30k=40-60%, >$30k=60-80%
- Sharp bettor: +15% | Recreational: -10%
- Coin-flip match (45-55% true prob): +10%
- Client has edge (fairWinProb > ${impliedProb.toFixed(4)}): +15%
- Reverse line movement detected: +15%
- Strong lossback offered (>10%): +5%

Calculate with your recommended offload %:
retained   = ${wagerNum} x (1 - offload/100)
offloaded  = ${wagerNum} x (offload/100)
netLose    = retained - ${lossbackAmt.toFixed(2)}     [our profit if client LOSES]
netWin     = -(retained x (${oddsNum} - 1))           [our loss if client WINS]
grossExp   = retained x ${oddsNum}                    [gross payout we write if client wins]
ibPayout   = offloaded x ${oddsNum}                   [iBankroll pays this if client wins]
ev         = (1 - fairWinProb) x netLose + fairWinProb x netWin

VERDICT:
- TAKE: clear edge, EV positive, low-moderate risk
- LEAN_TAKE: marginal edge or EV positive but higher risk
- LEAN_PASS: slight client edge or risk too high for current bankroll stage
- PASS: client has clear edge, EV negative, do not accept

Return ONLY valid JSON, no markdown, no extra text:

{
  "detectedSport": "string",
  "detectedMarket": "string",
  "fairOdds": number,
  "fairWinProb": number,
  "edgeVsMarket": number,
  "openingLine": number,
  "marketOdds": [
    {"book": "Pinnacle",   "price": number},
    {"book": "Bet365",     "price": number},
    {"book": "DraftKings", "price": number},
    {"book": "FanDuel",    "price": number},
    {"book": "PointsBet",  "price": number}
  ],
  "sharpOrRec": "sharp" | "recreational" | "unknown",
  "publicVsSharp": "one sentence on public vs sharp split",
  "recentForm": "two sentences on form and H2H",
  "lineMovement": "one sentence on line movement signals",
  "reverseLineMovement": true | false,
  "sharpAction": "one sentence on sharp money indicators",
  "weatherInjuries": "one sentence on injuries or conditions",
  "recommendedOffload": integer,
  "retained": number,
  "offloaded": number,
  "netLose": number,
  "netWin": number,
  "grossExp": number,
  "ibPayout": number,
  "ev": number,
  "riskScore": integer,
  "riskLabel": "Low" | "Moderate" | "High" | "Very High",
  "suggestedMaxWager": number,
  "kellyFraction": number,
  "clv": number,
  "keyRisks": "2-3 specific risks to our book on this bet",
  "offloadReasoning": "2 sentences explaining exactly why this offload % was chosen based on stake size, bettor profile and match risk",
  "verdict": "TAKE" | "LEAN_TAKE" | "LEAN_PASS" | "PASS",
  "verdictReason": "max 20 words",
  "aiAnalysis": "3 paragraphs: 1) Market assessment and fair value. 2) Why this offload % - stake size, bettor profile, match volatility. 3) Commercial recommendation with specific numbers.",
  "scenarios": [
    {"label": "Best case",  "pnl": number, "desc": "string"},
    {"label": "Base case",  "pnl": number, "desc": "string"},
    {"label": "Worst case", "pnl": number, "desc": "string"}
  ]
}`;

    const response = await withRetry(() => client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1800,
      messages:   [{ role: 'user', content: prompt }],
    }));

    const raw  = extractText(response.content);
    let data;
    try {
      data = parseJSON(raw);
    } catch (e) {
      console.error('[analyse] JSON parse failed. Raw:', raw.slice(0, 400));
      throw new Error('Model returned invalid JSON. Please try again.');
    }

    data.inputOdds     = oddsNum;
    data.inputWager    = wagerNum;
    data.inputLossback = lossbackPct;

    console.log(`[analyse] Done. Verdict: ${data.verdict}, Offload: ${data.recommendedOffload}%`);
    return res.json({ success: true, data });

  } catch (err) {
    console.error('[analyse] Error:', err.status, err.message);
    const msg = err.message || '';
    if (err.status === 401 || msg.includes('apiKey') || msg.includes('authentication')) {
      return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY is missing or invalid.' });
    }
    if (err.status === 429) return res.status(429).json({ success: false, error: 'Rate limit reached. Please wait a moment and try again.' });
    if (err.status === 529) return res.status(503).json({ success: false, error: 'Anthropic API is overloaded. Please try again.' });
    return res.status(500).json({ success: false, error: msg || 'Internal server error.' });
  }
};
