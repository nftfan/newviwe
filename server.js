import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---------- In-memory caches ----------
// Article meta cache: resolves Google redirect + scrapes og:image
const metaCache = new Map();
const META_TTL = 1000 * 60 * 60 * 12; // 12 hours

// RSS feed cache (shorter — news changes)
const feedCache = new Map();
const FEED_TTL = 1000 * 60 * 5; // 5 minutes

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br'
};

// ---------- Helpers ----------

// Strip HTML tags and decode entities for clean text
function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function stripTags(s) {
  if (!s) return '';
  return decodeEntities(s.replace(/<[^>]+>/g, '')).trim();
}

// Parse Google News RSS XML manually (it's small + simple)
function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];

    const getTag = (tag) => {
      const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
      const m = block.match(re);
      if (!m) return '';
      let v = m[1].trim();
      // Strip CDATA
      v = v.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();
      return v;
    };

    const rawTitle = getTag('title');
    const link = getTag('link');
    const pubDate = getTag('pubDate');
    const description = getTag('description');
    const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    const source = sourceMatch ? stripTags(sourceMatch[1]) : '';

    // Title in Google News usually ends with " - Source Name"
    let title = decodeEntities(rawTitle);
    let extractedSource = source;
    const dashMatch = title.match(/^(.+?)\s+-\s+([^-]+)$/);
    if (dashMatch) {
      title = dashMatch[1].trim();
      if (!extractedSource) extractedSource = dashMatch[2].trim();
    }

    items.push({
      title,
      link,
      pubDate,
      source: extractedSource || 'News',
      description: stripTags(description)
    });
  }
  return items;
}

// Resolve Google News redirect to the real article URL
async function resolveGoogleRedirect(googleUrl) {
  try {
    const res = await fetch(googleUrl, {
      headers: BROWSER_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(8000)
    });

    // If the redirect happened via HTTP, the final URL is the answer
    if (res.url && !res.url.includes('news.google.com')) {
      return res.url;
    }

    // Otherwise Google uses JS-based redirect — parse the HTML for the real URL
    const html = await res.text();

    // Look for the canonical link in the redirect interstitial
    // Pattern 1: <a href="https://realsite.com/article">
    const anchorMatch = html.match(/<a[^>]+href="(https?:\/\/(?!news\.google\.com)[^"]+)"/i);
    if (anchorMatch) return anchorMatch[1];

    // Pattern 2: data-n-au="..." or similar Google attribute
    const dataMatch = html.match(/data-n-au="(https?:\/\/[^"]+)"/i);
    if (dataMatch) return dataMatch[1];

    // Pattern 3: URL inside JS string
    const jsUrlMatch = html.match(/"(https?:\/\/(?!news\.google\.com|www\.google\.com)[^"]+)"/);
    if (jsUrlMatch) return jsUrlMatch[1];

    return googleUrl;
  } catch (err) {
    console.warn('Resolve failed:', err.message);
    return googleUrl;
  }
}

// Scrape og:image, og:description, og:title from a destination page
async function fetchPageMeta(url) {
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return {};

    // Only read first ~120KB — the <head> is always near the top
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let html = '';
    const MAX = 120 * 1024;
    while (html.length < MAX) {
      const { value, done } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (html.includes('</head>')) break;
    }
    try { reader.cancel(); } catch {}

    const finalUrl = res.url || url;

    const grab = (...patterns) => {
      for (const p of patterns) {
        const m = html.match(p);
        if (m && m[1]) return decodeEntities(m[1].trim());
      }
      return '';
    };

    const image = grab(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
      /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i
    );

    const description = grab(
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i
    );

    const ogTitle = grab(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
    );

    const siteName = grab(
      /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i
    );

    // Resolve relative image URLs
    let resolvedImage = image;
    if (image && !image.startsWith('http')) {
      try {
        resolvedImage = new URL(image, finalUrl).href;
      } catch {}
    }

    return {
      finalUrl,
      image: resolvedImage,
      description,
      ogTitle,
      siteName
    };
  } catch (err) {
    console.warn('Meta fetch failed:', err.message);
    return {};
  }
}

// ---------- Routes ----------

app.get('/', (req, res) => {
  res.json({
    name: 'Dispatch Server',
    status: 'ok',
    endpoints: ['/feed?url=<rss_url>', '/meta?url=<article_url>', '/health']
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    metaCacheSize: metaCache.size,
    feedCacheSize: feedCache.size,
    uptime: process.uptime()
  });
});

// Fetch and parse an RSS feed
app.get('/feed', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  // Cache check
  const cached = feedCache.get(url);
  if (cached && Date.now() - cached.t < FEED_TTL) {
    return res.json({ cached: true, items: cached.items });
  }

  try {
    const r = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!r.ok) {
      return res.status(502).json({ error: `Feed returned ${r.status}` });
    }
    const xml = await r.text();
    const items = parseRSS(xml);
    feedCache.set(url, { t: Date.now(), items });
    res.json({ cached: false, items });
  } catch (err) {
    console.error('Feed error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Resolve + scrape meta for an article URL
app.get('/meta', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  // Cache check
  const cached = metaCache.get(url);
  if (cached && Date.now() - cached.t < META_TTL) {
    return res.json({ cached: true, ...cached.data });
  }

  try {
    let targetUrl = url;
    if (url.includes('news.google.com')) {
      targetUrl = await resolveGoogleRedirect(url);
    }
    const meta = await fetchPageMeta(targetUrl);
    const data = {
      originalUrl: url,
      resolvedUrl: meta.finalUrl || targetUrl,
      image: meta.image || '',
      description: meta.description || '',
      ogTitle: meta.ogTitle || '',
      siteName: meta.siteName || ''
    };
    metaCache.set(url, { t: Date.now(), data });
    res.json({ cached: false, ...data });
  } catch (err) {
    console.error('Meta error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Cache eviction ----------
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of metaCache.entries()) {
    if (now - v.t > META_TTL) metaCache.delete(k);
  }
  for (const [k, v] of feedCache.entries()) {
    if (now - v.t > FEED_TTL) feedCache.delete(k);
  }
}, 1000 * 60 * 10);

app.listen(PORT, () => {
  console.log(`Dispatch server listening on :${PORT}`);
});
