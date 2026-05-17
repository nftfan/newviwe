import express from 'express';
import cors from 'cors';
import Parser from 'rss-parser';

const app = express();
const parser = new Parser();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ============================================================
// CACHE
// ============================================================
const metaCache = new Map();
const META_TTL = 1000 * 60 * 60 * 12;
const feedCache = new Map();
const FEED_TTL = 1000 * 60 * 5;

// ============================================================
// HEADERS — rotate UAs to avoid blocks
// ============================================================
const UA_POOL = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36'
];

function randomUA() { return UA_POOL[Math.floor(Math.random() * UA_POOL.length)]; }

function browserHeaders(extra = {}) {
  return {
    'User-Agent': randomUA(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    ...extra
  };
}

// ============================================================
// HELPERS
// ============================================================
function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function stripTags(s) {
  if (!s) return '';
  return decodeEntities(s.replace(/<[^>]+>/g, '')).trim();
}

// ============================================================
// GOOGLE REDIRECT RESOLVER — multiple strategies
// ============================================================
async function resolveGoogleRedirect(googleUrl) {
  // Strategy 1: follow fetch redirects (usually lands on final URL)
  try {
    const res = await fetch(googleUrl, {
      headers: browserHeaders(),
      redirect: 'follow',
      signal: AbortSignal.timeout(12000)
    });
    if (res.url && !res.url.includes('news.google.com')) {
      return res.url;
    }
    // Strategy 2: parse the HTML for the real URL
    const html = await res.text();
    const patterns = [
      /data-n-au="(https?:\/\/[^"]+)"/i,
      /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
      /href="(https?:\/\/(?!news\.google\.com|google\.com)[^"]+)"/i,
      /url=(https?:\/\/[^&"]+)/i,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m?.[1] && !m[1].includes('google.com')) return decodeURIComponent(m[1]);
    }
  } catch (e) {
    console.warn('Strategy 1/2 failed:', e.message);
  }

  // Strategy 3: HEAD request chain
  try {
    const res = await fetch(googleUrl, {
      method: 'HEAD',
      headers: browserHeaders(),
      redirect: 'follow',
      signal: AbortSignal.timeout(8000)
    });
    if (res.url && !res.url.includes('news.google.com')) return res.url;
  } catch (e) {
    console.warn('Strategy 3 failed:', e.message);
  }

  return googleUrl;
}

// ============================================================
// META SCRAPER — robust, reads only <head>
// ============================================================
async function fetchPageMeta(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(url, {
      headers: browserHeaders({ 'Referer': 'https://www.google.com/' }),
      redirect: 'follow',
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.warn('Meta fetch bad status:', res.status, url);
      return {};
    }

    // Stream only until </head> to save bandwidth
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let html = '';
    const MAX = 200 * 1024;

    while (html.length < MAX) {
      const { value, done } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (html.toLowerCase().includes('</head>')) break;
    }
    try { reader.cancel(); } catch {}

    const finalUrl = res.url || url;

    const grab = (...patterns) => {
      for (const p of patterns) {
        const m = html.match(p);
        if (m?.[1]) return decodeEntities(m[1].trim());
      }
      return '';
    };

    // Image — try many patterns
    const image = grab(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image:src["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image:src["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
      /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
      /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i
    );

    const description = grab(
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i,
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i
    );

    const ogTitle = grab(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i
    );

    const siteName = grab(
      /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i
    );

    // Resolve relative image URLs
    let resolvedImage = image;
    if (resolvedImage && !resolvedImage.startsWith('http')) {
      try { resolvedImage = new URL(resolvedImage, finalUrl).href; } catch {}
    }

    // Reject tiny tracking pixels / icons
    if (resolvedImage) {
      const lower = resolvedImage.toLowerCase();
      if (lower.includes('pixel') || lower.includes('1x1') || lower.endsWith('.ico')) {
        resolvedImage = '';
      }
    }

    return { finalUrl, image: resolvedImage, description, ogTitle, siteName };
  } catch (err) {
    clearTimeout(timeout);
    console.warn('Meta fetch failed:', err.message, url);
    return {};
  }
}

// ============================================================
// IMAGE PROXY — serves images through server to bypass CORS
// ============================================================
app.get('/img', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing url');

  try {
    const response = await fetch(url, {
      headers: browserHeaders({ 'Referer': new URL(url).origin }),
      redirect: 'follow',
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) return res.status(response.status).send('Upstream error');

    const ct = response.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Stream the image
    const reader = response.body.getReader();
    const pump = async () => {
      const { value, done } = await reader.read();
      if (done) { res.end(); return; }
      res.write(Buffer.from(value));
      return pump();
    };
    await pump();
  } catch (err) {
    console.warn('Image proxy error:', err.message);
    res.status(502).send('Image fetch failed');
  }
});

// ============================================================
// ROOT
// ============================================================
app.get('/', (req, res) => {
  res.json({ name: 'Dispatch Server', status: 'ok', endpoints: ['/feed?url=', '/meta?url=', '/img?url=', '/health'] });
});

// ============================================================
// HEALTH
// ============================================================
app.get('/health', (req, res) => {
  res.json({ ok: true, metaCacheSize: metaCache.size, feedCacheSize: feedCache.size, uptime: process.uptime() });
});

// ============================================================
// FEED
// ============================================================
app.get('/feed', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  const cached = feedCache.get(url);
  if (cached && Date.now() - cached.t < FEED_TTL) {
    return res.json({ cached: true, items: cached.items });
  }

  try {
    const r = await fetch(url, {
      headers: { ...browserHeaders(), Accept: 'application/rss+xml, application/xml, text/xml;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000)
    });

    if (!r.ok) return res.status(502).json({ error: `Feed returned ${r.status}` });

    const xml = await r.text();
    const parsed = await parser.parseString(xml);

    const items = (parsed.items || []).map(item => ({
      title: stripTags(item.title || ''),
      link: item.link || '',
      pubDate: item.pubDate || '',
      source: item.creator || item.author || parsed.title || 'News',
      description: stripTags(item.contentSnippet || item.content || item.summary || '')
    }));

    feedCache.set(url, { t: Date.now(), items });
    res.json({ cached: false, items });
  } catch (err) {
    console.error('Feed error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// META
// ============================================================
app.get('/meta', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  const cached = metaCache.get(url);
  if (cached && Date.now() - cached.t < META_TTL) {
    return res.json({ cached: true, ...cached.data });
  }

  try {
    let targetUrl = url;
    if (url.includes('news.google.com')) {
      targetUrl = await resolveGoogleRedirect(url);
      console.log('Resolved:', url.slice(0, 60), '->', targetUrl.slice(0, 80));
    }

    const meta = await fetchPageMeta(targetUrl);

    // Proxy the image URL through our /img endpoint so the client
    // never hits CORS/referrer blocks
    const proxyImage = meta.image
      ? `/img?url=${encodeURIComponent(meta.image)}`
      : '';

    const data = {
      originalUrl: url,
      resolvedUrl: meta.finalUrl || targetUrl,
      image: proxyImage,
      description: meta.description || '',
      ogTitle: meta.ogTitle || '',
      siteName: meta.siteName || ''
    };

    metaCache.set(url, { t: Date.now(), data });
    res.json({ cached: false, ...data });
  } catch (err) {
    console.error('Meta error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CACHE CLEANUP
// ============================================================
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of metaCache.entries()) { if (now - v.t > META_TTL) metaCache.delete(k); }
  for (const [k, v] of feedCache.entries()) { if (now - v.t > FEED_TTL) feedCache.delete(k); }
}, 1000 * 60 * 10);

// ============================================================
// START
// ============================================================
app.listen(PORT, () => console.log(`Dispatch server listening on :${PORT}`));
