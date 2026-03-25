'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function extractText(content) {
  if (!Array.isArray(content)) return String(content);
  return content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

function parseJSON(raw) {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(stripped);
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed.' });

  try {
    const {
      matchup, sport, market, selection,
      odds, wager, offloadPct, marginPct,
      retained, offloaded, ibOdds, netWin, netLose, ev,
    } = req.body;

    if (!matchup || !sport || !market || !selection || !odds || !wager) {
      return res.status(400).json({ success: false, error: 'Missing required fields.' });
    }

    const oddsNum       = parseFloat(odds);
    const wagerNum      = parseFloat(wager);
    const offloadPctNum = parseFloat(offloadPct) || 50;
    const marginPctNum  = parseFloat(marginPct)  || 5;

    const retainedCalc = retained ?? wagerNum * (1 - offloadPctNum / 100);
    const offloadedCalc = offloaded ?? wagerNum * (offloadPctNum / 100);
    const ibOddsCalc    = ibOdds   ?? oddsNum * (1 - marginPctNum / 100);
    const netWinCalc    = netWin   ?? (offloadedCalc * (ibOddsCalc - 1) - wagerNum * (oddsNum - 1) + wagerNum);
    const netLoseCalc   = netLose  ?? retainedCalc;
    const evCalc        = ev       ?? ((1 / oddsNum) * netWinCalc - (1 - 1 / oddsNum) * retainedCalc);

    const fmt = n => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    // ── Phase 1: Web search ──────────────────────────────────────────────────
    const searchPrompt = `You are an expert sports betting analyst with access to real-time web search.

Research the following bet thoroughly using multiple web searches:

FIXTURE: ${matchup}
SPORT: ${sport}
MARKET: ${market}
SELECTION: ${selection}
DECIMAL ODDS OFFERED: ${oddsNum}

Please search for:
1. "${matchup} odds ${market} Pinnacle Bet365 DraftKings" — current live odds from major bookmakers
2. "${matchup} ${sport} preview form statistics head to head" — recent form, H2H record, team/player stats
3. "${matchup} line movement sharp action betting" — line movement and sharp money indicators
4. "${matchup} injury report team news ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}" — injury and team news

Gather as much data as possible. I will use your findings for a detailed risk analysis.`;

    console.log(`[analyse] Web search phase: ${matchup}`);

    const searchResponse = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8096,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: searchPrompt }],
    });

    const searchResults = extractText(searchResponse.content);
    console.log(`[analyse] Web search done. stop_reason=${searchResponse.stop_reason}`);

    // ── Phase 2: Structured analysis ────────────────────────────────────────
    const impliedProb   = (1 / oddsNum);
    const breakEvenProb = impliedProb;
    const kellyApprox   = Math.max(0, ((oddsNum - 1) * impliedProb - (1 - impliedProb)) / (oddsNum - 1));

    const analysisPrompt = `You are a professional sports betting risk analyst and quant trader. Using the web search data below, produce a complete JSON risk analysis.

═══════════════════════════════════════════
BET DETAILS
═══════════════════════════════════════════
Fixture:        ${matchup}
Sport:          ${sport}
Market:         ${market}
Selection:      ${selection}
Decimal Odds:   ${oddsNum}
Total Wager:    ${fmt(wagerNum)}
Offload %:      ${offloadPctNum}%
Your Margin %:  ${marginPctNum}%

═══════════════════════════════════════════
PRE-CALCULATED FINANCIALS
═══════════════════════════════════════════
Retained Stake (your exposure):   ${fmt(retainedCalc)}
Offloaded to iBankroll:           ${fmt(offloadedCalc)}
iBankroll Price (odds × margin):  ${ibOddsCalc.toFixed(4)}
Net Profit if Win:                ${fmt(netWinCalc)}
Net Loss if Lose:                 -${fmt(netLoseCalc)}
Expected Value (EV):              ${fmt(evCalc)} ${evCalc >= 0 ? '(POSITIVE)' : '(NEGATIVE)'}
Implied Probability:              ${(impliedProb * 100).toFixed(2)}%
Break-Even Probability:           ${(breakEvenProb * 100).toFixed(2)}%
Kelly Fraction (approx):          ${(kellyApprox * 100).toFixed(2)}%

═══════════════════════════════════════════
WEB SEARCH RESULTS
═══════════════════════════════════════════
${searchResults}

═══════════════════════════════════════════
INSTRUCTIONS
═══════════════════════════════════════════
Using ALL data above, produce a comprehensive risk analysis. Be specific and data-driven.

For marketOdds: use actual odds from search data. If unavailable, estimate realistically.
For fairOdds: your genuine probabilistic assessment of the true fair price.
For riskScore: 1=very low risk, 100=extremely high risk.
For scenarios:
  - Best case: net profit if win AND conditions most favourable
  - Base case: expected outcome at implied probability
  - Worst case: net loss if bet loses
For aiAnalysis: exactly 4 paragraphs (double-newline separated):
  (1) market overview & odds context
  (2) form/statistics analysis
  (3) sharp action & line movement
  (4) commercial recommendation & risk management

Respond ONLY with a valid JSON object matching this exact schema — no markdown fences, no extra text:

{
  "verdict": "TAKE" | "LEAN_TAKE" | "LEAN_PASS" | "PASS",
  "verdictReason": "string (max 25 words)",
  "riskScore": number between 1 and 100,
  "riskLabel": "Low" | "Moderate" | "High" | "Very High",
  "fairOdds": number,
  "impliedProb": number between 0 and 1,
  "marketOdds": [
    {"book": "Pinnacle", "price": number},
    {"book": "Bet365", "price": number},
    {"book": "DraftKings", "price": number},
    {"book": "FanDuel", "price": number},
    {"book": "PointsBet", "price": number}
  ],
  "optimalOffload": number between 0 and 100,
  "suggestedMaxWager": number,
  "edgeVsMarket": number,
  "kellyFraction": number,
  "clv": number,
  "recentForm": "string",
  "lineMovement": "string",
  "keyRisks": "string",
  "aiAnalysis": "paragraph1\\n\\nparagraph2\\n\\nparagraph3\\n\\nparagraph4",
  "breakEvenProb": number between 0 and 1,
  "sharpAction": "string",
  "publicVsSharp": "string",
  "weatherInjuries": "string",
  "scenarios": [
    {"label": "Best case", "pnl": number, "desc": "string"},
    {"label": "Base case", "pnl": number, "desc": "string"},
    {"label": "Worst case", "pnl": number, "desc": "string"}
  ]
}`;

    console.log(`[analyse] Structured analysis call...`);

    const analysisResponse = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: analysisPrompt }],
    });

    const rawJSON = extractText(analysisResponse.content);
    console.log(`[analyse] Analysis complete. Parsing JSON...`);

    let data;
    try {
      data = parseJSON(rawJSON);
    } catch (parseErr) {
      console.error('[analyse] JSON parse error:', parseErr.message);
      return res.status(500).json({
        success: false,
        error: 'Model returned invalid JSON. Please try again.',
      });
    }

    return res.json({ success: true, data });

  } catch (err) {
    console.error('[analyse] Error:', err);
    if (err.status === 401) return res.status(500).json({ success: false, error: 'Invalid Anthropic API key.' });
    if (err.status === 429) return res.status(429).json({ success: false, error: 'Rate limit reached. Please try again.' });
    return res.status(500).json({ success: false, error: err.message || 'Internal server error.' });
  }
};
