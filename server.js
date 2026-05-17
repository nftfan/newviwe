import express from 'express';
import cors from 'cors';
import Parser from 'rss-parser';

const app = express();
const parser = new Parser({
  customFields: {
    item: [['source', 'source', { keepArray: false }]]
  }
});

const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const metaCache = new Map();
const META_TTL  = 1000 * 60 * 60 * 12;
const feedCache = new Map();
const FEED_TTL  = 1000 * 60 * 5;

const UA_POOL = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
];
const rUA = () => UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
const bH  = (extra = {}) => ({
  'User-Agent': rUA(),
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  ...extra
});

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g,  '&').replace(/&lt;/g,   '<').replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g,           (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function stripTags(s) {
  if (!s) return '';
  return decodeEntities(s.replace(/<[^>]+>/g, '')).trim();
}

function extractRealUrlFromDescription(description) {
  if (!description) return null;
  const hrefRe = /href=["']?(https?:\/\/[^"'\s>]+)["']?/gi;
  const matches = [];
  let m;
  while ((m = hrefRe.exec(description)) !== null) {
    const url = decodeEntities(m[1]);
    if (!url.includes('google.com') && !url.includes('googleapis.com')) {
      matches.push(url);
    }
  }
  return matches[0] || null;
}

async function fetchPageMeta(url) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      headers: bH({ 'Referer': 'https://www.google.com/' }),
      redirect: 'follow',
      signal: controller.signal
    });
    clearTimeout(tid);
    if (!res.ok) { console.warn('Meta bad status', res.status, url); return {}; }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let html = '';
    while (html.length < 200 * 1024) {
      const { value, done } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (html.toLowerCase().includes('</head>')) break;
    }
    try { reader.cancel(); } catch {}

    const finalUrl = res.url || url;
    const grab = (...pats) => {
      for (const p of pats) {
        const m = html.match(p);
        if (m?.[1]) return decodeEntities(m[1].trim());
      }
      return '';
    };

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

    const ogTitle  = grab(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    const siteName = grab(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);

    let resolvedImage = image;
    if (resolvedImage && !resolvedImage.startsWith('http')) {
      try { resolvedImage = new URL(resolvedImage, finalUrl).href; } catch {}
    }
    if (resolvedImage) {
      const l = resolvedImage.toLowerCase();
      if (l.includes('1x1') || l.endsWith('.ico') || l.includes('pixel.gif')) resolvedImage = '';
    }

    return { finalUrl, image: resolvedImage, description, ogTitle, siteName };
  } catch (err) {
    clearTimeout(tid);
    console.warn('Meta fetch failed:', err.message);
    return {};
  }
}

app.get('/img', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing url');
  try {
    const upstream = await fetch(url, {
      headers: bH({ 'Referer': (() => { try { return new URL(url).origin; } catch { return ''; } })() }),
      redirect: 'follow',
      signal: AbortSignal.timeout(10000)
    });
    if (!upstream.ok) return res.status(upstream.status).send('Upstream error');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const reader = upstream.body.getReader();
    const pump = async () => {
      const { value, done } = await reader.read();
      if (done) return res.end();
      res.write(Buffer.from(value));
      return pump();
    };
    await pump();
  } catch (err) {
    console.warn('Image proxy error:', err.message);
    res.status(502).send('Image fetch failed');
  }
});

app.get('/', (_req, res) => res.json({
  name: 'Dispatch Server', status: 'ok',
  endpoints: ['/feed?url=', '/meta?url=', '/img?url=', '/health']
}));

app.get('/health', (_req, res) => res.json({
  ok: true, metaCacheSize: metaCache.size, feedCacheSize: feedCache.size, uptime: process.uptime()
}));

app.get('/feed', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  const hit = feedCache.get(url);
  if (hit && Date.now() - hit.t < FEED_TTL) return res.json({ cached: true, items: hit.items });

  try {
    const r = await fetch(url, {
      headers: bH({ Accept: 'application/rss+xml, application/xml, text/xml;q=0.9,*/*;q=0.8' }),
      redirect: 'follow',
      signal: AbortSignal.timeout(12000)
    });
    if (!r.ok) return res.status(502).json({ error: `Feed returned ${r.status}` });

    const xml = await r.text();
    const parsed = await parser.parseString(xml);

    const rawDescriptions = [...xml.matchAll(/<description>([\s\S]*?)<\/description>/g)]
      .slice(1)
      .map(m => m[1]);

    const items = (parsed.items || []).map((item, i) => {
      const rawDesc = rawDescriptions[i] || '';
      const realUrl = extractRealUrlFromDescription(rawDesc) || item.link || '';
      const sourceName =
        (item.source && typeof item.source === 'object' ? item.source._ : item.source) ||
        item.creator || item.author || parsed.title || 'News';
      const title = stripTags(item.title || '').replace(/\s+-\s+[^-]+$/, '').trim();
      return {
        title,
        link: realUrl,
        googleLink: item.link || '',
        pubDate: item.pubDate || '',
        source: stripTags(String(sourceName)),
        description: stripTags(item.contentSnippet || item.content || item.summary || '')
      };
    });

    feedCache.set(url, { t: Date.now(), items });
    res.json({ cached: false, items });
  } catch (err) {
    console.error('Feed error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/meta', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  const hit = metaCache.get(url);
  if (hit && Date.now() - hit.t < META_TTL) return res.json({ cached: true, ...hit.data });

  try {
    if (url.includes('news.google.com')) {
      return res.json({ cached: false, image: '', description: '', resolvedUrl: url, siteName: '' });
    }

    const meta = await fetchPageMeta(url);
    const proxyImage = meta.image ? `/img?url=${encodeURIComponent(meta.image)}` : '';

    const data = {
      resolvedUrl:  meta.finalUrl || url,
      image:        proxyImage,
      description:  meta.description || '',
      ogTitle:      meta.ogTitle || '',
      siteName:     meta.siteName || ''
    };

    metaCache.set(url, { t: Date.now(), data });
    res.json({ cached: false, ...data });
  } catch (err) {
    console.error('Meta error:', err);
    res.status(500).json({ error: err.message });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of metaCache.entries()) if (now - v.t > META_TTL) metaCache.delete(k);
  for (const [k, v] of feedCache.entries()) if (now - v.t > FEED_TTL) feedCache.delete(k);
}, 1000 * 60 * 10);

app.listen(PORT, () => console.log(`Dispatch server listening on :${PORT}`));
