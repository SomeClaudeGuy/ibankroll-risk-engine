'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function extractText(content) {
  if (!Array.isArray(content)) return String(content);
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

function parseJSON(raw) {
  // Strip markdown code fences if present
  const stripped = raw.replace(/```[\w]*\n?/g, '').trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in response');
  return JSON.parse(match[0]);
}

async function withRetry(fn, retries = 2, delayMs = 3000) {
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

async function callClaude(prompt, maxTokens, useSearch = false) {
  const params = {
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (useSearch) {
    params.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }
  const response = await withRetry(() => client.messages.create(params));
  const raw = extractText(response.content);
  try {
    return parseJSON(raw);
  } catch (e) {
    console.error('[analyse] JSON parse failed. Raw output:', raw.slice(0, 300));
    throw new Error('Model returned invalid JSON. Please try again.');
  }
}

// ── Phase 1: Market Intelligence (with live web search) ──────────────────────
async function phase1(matchup, selection, oddsNum) {
  const prompt = `You are a senior sports odds analyst. Use web search to find CURRENT live odds for this fixture from major bookmakers, then assess the bet.

Fixture:   ${matchup}
Selection: ${selection}
Our price: ${oddsNum} (decimal)

Search for TWO things:
1. "${matchup} ${selection} odds" - find current prices on Pinnacle, Bet365, DraftKings, FanDuel, PointsBet. Also find the opening line.
2. "${matchup} injuries news form" - recent team form, H2H, injuries, lineup news.

Return ONLY this JSON (no markdown, no text outside JSON):
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
  "publicVsSharp": "e.g. 68% public on selection but line moved against - reverse line movement signal",
  "recentForm": "2 sentences on recent form and H2H",
  "lineMovement": "1 sentence on line movement since open (opened X now Y)",
  "reverseLineMovement": true | false,
  "sharpAction": "1 sentence on where sharp/syndicate money is pointing",
  "weatherInjuries": "1 sentence on injuries, lineup news or conditions (none if N/A)"
}`;
  return callClaude(prompt, 800, true);
}

// ── Phase 2: Risk & Offload ──────────────────────────────────────────────────
async function phase2(matchup, selection, oddsNum, wagerNum, lossbackPct, lossbackAmt, p1) {
  const prompt = `You are a bookmaker risk manager. Recommend offload % and calculate P&L.

Fixture:       ${matchup}
Selection:     ${selection}
Client odds:   ${oddsNum}
Client stake:  $${wagerNum.toLocaleString('en-US')}
Lossback:      ${lossbackPct > 0 ? `${lossbackPct}% = $${lossbackAmt.toFixed(2)} refunded to client if they LOSE` : 'None'}

MARKET CONTEXT (from Phase 1):
Sport/Market:  ${p1.detectedSport || 'Unknown'} / ${p1.detectedMarket || 'Unknown'}
Fair odds:     ${p1.fairOdds || oddsNum}  |  Fair win prob: ${((p1.fairWinProb || 1/oddsNum)*100).toFixed(1)}%
Edge vs market: ${((p1.edgeVsMarket||0)*100).toFixed(2)}%
Bettor profile: ${p1.sharpOrRec || 'unknown'}
Line movement:  ${p1.lineMovement || 'unknown'}

OFFLOAD SCORING:
Stake $${wagerNum.toLocaleString('en-US')}: ${wagerNum < 5000 ? '0-15% base offload' : wagerNum < 15000 ? '20-40% base offload' : wagerNum < 30000 ? '40-60% base offload' : '60-80% base offload'}
Bettor sharp: ${p1.sharpOrRec === 'sharp' ? '+15%' : p1.sharpOrRec === 'recreational' ? '-10%' : '+5%'}
Coin-flip match (45-55% prob): ${(p1.fairWinProb||0) >= 0.45 && (p1.fairWinProb||0) <= 0.55 ? '+10%' : '0%'}
Client has edge on us (fairWinProb > 1/clientOdds): ${(p1.fairWinProb||0) > 1/oddsNum ? 'YES +15%' : 'NO 0%'}
Reverse line movement detected: ${p1.reverseLineMovement ? 'YES - sharp signal, +15%' : 'NO'}
Public vs sharp split: ${p1.publicVsSharp || 'unknown'}

FORMULAS (use recommended offload %):
retained   = ${wagerNum} × (1 - offload/100)
offloaded  = ${wagerNum} × (offload/100)
netLose    = retained - ${lossbackAmt.toFixed(2)}
netWin     = -(retained × (${oddsNum}-1))
ev         = (1-${(p1.fairWinProb || 1/oddsNum).toFixed(4)}) × netLose + ${(p1.fairWinProb || 1/oddsNum).toFixed(4)} × netWin

Return ONLY this JSON:
{
  "recommendedOffload": integer,
  "retained": number,
  "offloaded": number,
  "netLose": number,
  "netWin": number,
  "ev": number,
  "riskScore": integer 1-100,
  "riskLabel": "Low" | "Moderate" | "High" | "Very High",
  "suggestedMaxWager": number,
  "kellyFraction": number,
  "clv": number,
  "keyRisks": "2-3 specific risks to our book on this bet",
  "offloadReasoning": "2 sentences explaining exactly why this offload % was chosen"
}`;
  return callClaude(prompt, 500);
}

// ── Phase 3: Verdict ──────────────────────────────────────────────────────────
async function phase3(matchup, selection, oddsNum, wagerNum, lossbackPct, p1, p2) {
  const grossExp   = p2.retained * oddsNum;
  const ibPayout   = p2.offloaded * oddsNum;
  const breakEven  = p2.netLose / (p2.retained * oddsNum - (wagerNum * lossbackPct / 100));

  const prompt = `You are a bookmaker commercial director. Give the final verdict on accepting this bet.

Fixture:    ${matchup}
Selection:  ${selection} @ ${oddsNum}
Stake:      $${wagerNum.toLocaleString('en-US')}

RISK SUMMARY:
Fair win prob:      ${(p1.fairWinProb*100).toFixed(1)}%  (client implied: ${(100/oddsNum).toFixed(1)}%)
Edge for us:        ${p1.fairWinProb < 1/oddsNum ? 'YES - client is paying above fair value' : 'NO - client has edge on this price'}
Bettor:             ${p1.sharpOrRec}
Risk score:         ${p2.riskScore}/100 (${p2.riskLabel})
Recommended offload: ${p2.recommendedOffload}%

P&L IF CLIENT LOSES (we win): $${p2.netLose.toFixed(2)}
P&L IF CLIENT WINS (we lose): We pay $${grossExp.toFixed(2)}, iBankroll pays $${ibPayout.toFixed(2)}
EV: $${p2.ev.toFixed(2)}
Break-even: we need client to lose >${(breakEven*100).toFixed(1)}% of the time

Return ONLY this JSON:
{
  "verdict": "TAKE" | "LEAN_TAKE" | "LEAN_PASS" | "PASS",
  "verdictReason": "max 20 words",
  "aiAnalysis": "Market: fair odds and whether client has edge.\\n\\nOffload logic: why ${p2.recommendedOffload}% offload for this specific bet.\\n\\nVerdict: gross split if wins (we pay $${grossExp.toFixed(0)}, iBankroll $${ibPayout.toFixed(0)}), profit if loses, EV and recommendation.",
  "scenarios": [
    {"label": "Best case",  "pnl": ${p2.netLose.toFixed(2)}, "desc": "Client loses - we keep $${p2.netLose.toFixed(0)} profit${lossbackPct > 0 ? ' after lossback' : ''}. iBankroll keeps their $${p2.offloaded.toFixed(0)}."},
    {"label": "Base case",  "pnl": ${p2.ev.toFixed(2)}, "desc": "EV-weighted outcome across fair probabilities."},
    {"label": "Worst case", "pnl": ${(-grossExp).toFixed(2)}, "desc": "Client wins - we pay $${grossExp.toFixed(0)}, iBankroll pays $${ibPayout.toFixed(0)}."}
  ]
}`;
  return callClaude(prompt, 700);
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed.' });

  try {
    const { matchup, selection, odds, wager, lossback, phase, context } = req.body;

    if (!matchup || !selection || !odds || !wager) {
      return res.status(400).json({ success: false, error: 'Fixture, selection, odds and wager are required.' });
    }

    const oddsNum     = parseFloat(odds);
    const wagerNum    = parseFloat(wager);
    const lossbackPct = Math.min(Math.max(parseFloat(lossback) || 0, 0), 15);
    const lossbackAmt = wagerNum * (lossbackPct / 100);

    if (isNaN(oddsNum) || oddsNum < 1.01) return res.status(400).json({ success: false, error: 'Odds must be ≥ 1.01.' });
    if (isNaN(wagerNum) || wagerNum <= 0)  return res.status(400).json({ success: false, error: 'Wager must be > 0.' });

    const phaseNum = parseInt(phase) || 1;
    const ctx      = context || {};

    console.log(`[analyse] Phase ${phaseNum} - ${matchup} / ${selection} @ ${oddsNum}`);

    let data;
    if (phaseNum === 1) {
      data = await phase1(matchup, selection, oddsNum);
    } else if (phaseNum === 2) {
      data = await phase2(matchup, selection, oddsNum, wagerNum, lossbackPct, lossbackAmt, ctx.p1);
    } else {
      data = await phase3(matchup, selection, oddsNum, wagerNum, lossbackPct, ctx.p1, ctx.p2);
    }

    data.inputOdds     = oddsNum;
    data.inputWager    = wagerNum;
    data.inputLossback = lossbackPct;

    console.log(`[analyse] Phase ${phaseNum} done.`);
    return res.json({ success: true, phase: phaseNum, data });

  } catch (err) {
    console.error('[analyse] Error:', err.status, err.message);
    const msg = err.message || '';
    if (err.status === 401 || msg.includes('apiKey') || msg.includes('authToken') || msg.includes('authentication')) {
      return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY is missing or invalid. Add it in Vercel Project Settings > Environment Variables.' });
    }
    if (err.status === 429) return res.status(429).json({ success: false, error: 'Rate limit reached. Please wait a moment.' });
    if (err.status === 529) return res.status(503).json({ success: false, error: 'Anthropic API is overloaded. Please try again in a moment.' });
    return res.status(500).json({ success: false, error: msg || 'Internal server error.' });
  }
};
