'use strict';

// Quick diagnostic endpoint — tests Betby feed reachability from Vercel
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  const brandId = process.env.BETBY_BRAND_ID;
  const env     = process.env.BETBY_ENV || 'prod';
  const url     = env === 'prod'
    ? `https://api-raeth4un-feed.sptpub.com/api/v1/promofeed/brand/${brandId}/en`
    : `https://api.invisiblesport.com/api/v1/promofeed/brand/${brandId}/en`;

  const start = Date.now();
  try {
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const elapsed = Date.now() - start;

    if (!resp.ok) {
      return res.json({ ok: false, status: resp.status, url, elapsed });
    }

    // Just read the first 1000 chars to check it's valid JSON
    const text = await resp.text();
    const preview = text.slice(0, 200);
    const isJson = text.trim().startsWith('{') || text.trim().startsWith('[');

    return res.json({
      ok: true,
      status: resp.status,
      elapsed,
      bytes: text.length,
      isJson,
      preview,
      url,
      brandId: brandId ? brandId.slice(0, 8) + '...' : 'NOT SET',
      env,
    });
  } catch (err) {
    return res.json({ ok: false, error: err.message, elapsed: Date.now() - start, url });
  }
};
