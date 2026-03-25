'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Health ────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), webSearch: true });
});

// ─── Helpers ───────────────────────────────────────────────────────────────
function extractText(content) {
  if (!Array.isArray(content)) return String(content);
  return content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

function parseJSON(raw) {
  // Strip markdown fences if present
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(stripped);
}

// ─── Main analysis endpoint ─────────────────────────────────────────────────
app.post('/api/analyse', async (req, res) => {
  try {
    const {
      matchup,
      sport,
      market,
      selection,
      odds,
      wager,
      offloadPct,
      marginPct,
      // Pre-calculated financials sent from client
      retained,
      offloaded,
      ibOdds,
      netWin,
      netLose,
      ev,
    } = req.body;

    // Validate required fields
    if (!matchup || !sport || !market || !selection || !odds || !wager) {
      return res.status(400).json({ success: false, error: 'Missing required fields.' });
    }

    const oddsNum = parseFloat(odds);
    const wagerNum = parseFloat(wager);
    const offloadPctNum = parseFloat(offloadPct) || 50;
    const marginPctNum = parseFloat(marginPct) || 5;

    const retainedCalc = retained ?? wagerNum * (1 - offloadPctNum / 100);
    const offloadedCalc = offloaded ?? wagerNum * (offloadPctNum / 100);
    const ibOddsCalc = ibOdds ?? oddsNum * (1 - marginPctNum / 100);
    const netWinCalc = netWin ?? (offloadedCalc * (ibOddsCalc - 1) - wagerNum * (oddsNum - 1) + wagerNum);
    const netLoseCalc = netLose ?? retainedCalc;
    const evCalc = ev ?? ((1 / oddsNum) * netWinCalc - (1 - 1 / oddsNum) * retainedCalc);

    const fmt = n => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    // ── Phase 1: Web search ────────────────────────────────────────────────
    const searchPrompt = `You are an expert sports betting analyst with access to real-time web search.

I need you to research the following bet thoroughly using web search:

FIXTURE: ${matchup}
SPORT: ${sport}
MARKET: ${market}
SELECTION: ${selection}
DECIMAL ODDS OFFERED: ${oddsNum}

Please search for the following information using multiple searches:
1. Search: "${matchup} odds ${market} Pinnacle Bet365 DraftKings" — to find current live odds from multiple bookmakers
2. Search: "${matchup} ${sport} preview form statistics head to head" — to find recent form, H2H record, team/player statistics
3. Search: "${matchup} line movement sharp action betting" — to find line movement data and sharp money indicators
4. Search: "${matchup} injury report team news ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}" — to find any injury/team news

Gather as much data as possible from these searches. I will use your findings for a detailed risk analysis.`;

    console.log(`[analyse] Starting web search phase for: ${matchup}`);

    const searchResponse = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8096,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: searchPrompt }],
    });

    const searchResults = extractText(searchResponse.content);
    console.log(`[analyse] Web search complete. stop_reason=${searchResponse.stop_reason}`);

    // ── Phase 2: Structured analysis ────────────────────────────────────────
    const impliedProb = (1 / oddsNum).toFixed(4);
    const breakEvenProb = (1 / oddsNum).toFixed(4);
    const kellyApprox = Math.max(0, ((oddsNum - 1) * parseFloat(impliedProb) - (1 - parseFloat(impliedProb))) / (oddsNum - 1)).toFixed(4);

    const analysisPrompt = `You are a professional sports betting risk analyst and quant trader. Using the web search data below, produce a complete JSON risk analysis for this bet.

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
Implied Probability:              ${(parseFloat(impliedProb) * 100).toFixed(2)}%
Break-Even Probability:           ${(parseFloat(breakEvenProb) * 100).toFixed(2)}%
Kelly Fraction (approx):          ${(parseFloat(kellyApprox) * 100).toFixed(2)}%

═══════════════════════════════════════════
WEB SEARCH RESULTS
═══════════════════════════════════════════
${searchResults}

═══════════════════════════════════════════
INSTRUCTIONS
═══════════════════════════════════════════
Using ALL of the above data, produce a comprehensive risk analysis. Be specific and data-driven.

For marketOdds: extract actual odds from the web search data for Pinnacle, Bet365, DraftKings, FanDuel, PointsBet. If you cannot find exact odds for a book, estimate realistically based on the market.

For fairOdds: your genuine probabilistic assessment of the true fair price, accounting for the juice.

For riskScore: 1=very low risk, 100=extremely high risk. Consider volatility, line movement, injury news, public vs sharp action, stake size relative to market.

For scenarios:
- Best case pnl = net profit if the bet wins AND conditions are most favourable
- Base case pnl = expected outcome
- Worst case pnl = net loss if bet loses

For aiAnalysis: write exactly 4 paragraphs separated by double newlines. Cover: (1) market overview & odds context, (2) form/statistics analysis, (3) sharp action & line movement, (4) commercial recommendation & risk management.

Respond ONLY with a valid JSON object matching this exact schema, no markdown fences, no extra text:

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
  "edgeVsMarket": number (positive = edge, negative = no edge),
  "kellyFraction": number,
  "clv": number,
  "recentForm": "string",
  "lineMovement": "string",
  "keyRisks": "string",
  "aiAnalysis": "paragraph1\n\nparagraph2\n\nparagraph3\n\nparagraph4",
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

    console.log(`[analyse] Starting structured analysis call...`);

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
      console.error('[analyse] Raw response (first 500 chars):', rawJSON.slice(0, 500));
      return res.status(500).json({
        success: false,
        error: 'Model returned invalid JSON. Please try again.',
        raw: rawJSON.slice(0, 1000),
      });
    }

    return res.json({ success: true, data });
  } catch (err) {
    console.error('[analyse] Unhandled error:', err);

    if (err.status === 401) {
      return res.status(500).json({ success: false, error: 'Invalid Anthropic API key. Set ANTHROPIC_API_KEY environment variable.' });
    }
    if (err.status === 429) {
      return res.status(429).json({ success: false, error: 'Rate limit reached. Please wait a moment and try again.' });
    }
    if (err.status === 400) {
      return res.status(500).json({ success: false, error: `API request error: ${err.message}` });
    }

    return res.status(500).json({ success: false, error: err.message || 'Internal server error.' });
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  iBankroll Risk Engine`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  Server:    http://localhost:${PORT}`);
  console.log(`  Health:    http://localhost:${PORT}/health`);
  console.log(`  API Key:   ${process.env.ANTHROPIC_API_KEY ? '✓ Set' : '✗ MISSING — set ANTHROPIC_API_KEY'}`);
  console.log(`  Web Search: Enabled (server-side via Anthropic)\n`);
});
