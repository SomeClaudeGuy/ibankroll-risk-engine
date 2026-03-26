'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const handler = require('./api/analyse');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.post('/api/analyse', handler);

app.listen(PORT, () => {
  console.log(`\n  iBankroll Risk Engine`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  Server:  http://localhost:${PORT}`);
  console.log(`  API Key: ${process.env.ANTHROPIC_API_KEY ? '✓ Set' : '✗ MISSING - set ANTHROPIC_API_KEY'}\n`);
});
