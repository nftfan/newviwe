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
// HEADERS
// ============================================================

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',

  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',

  'Accept-Language': 'en-US,en;q=0.9'
};

// ============================================================
// HELPERS
// ============================================================

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
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCodePoint(parseInt(h, 16))
    )
    .replace(/&#(\d+);/g, (_, d) =>
      String.fromCodePoint(parseInt(d, 10))
    );
}

function stripTags(s) {
  if (!s) return '';

  return decodeEntities(
    s.replace(/<[^>]+>/g, '')
  ).trim();
}

// ============================================================
// GOOGLE REDIRECT RESOLVER
// ============================================================

async function resolveGoogleRedirect(googleUrl) {
  try {
    const res = await fetch(googleUrl, {
      headers: BROWSER_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(10000)
    });

    // Usually fetch resolves directly
    if (
      res.url &&
      !res.url.includes('news.google.com')
    ) {
      return res.url;
    }

    const html = await res.text();

    // canonical
    const canonical = html.match(
      /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i
    );

    if (canonical?.[1]) {
      return canonical[1];
    }

    // Google redirect attr
    const dataMatch = html.match(
      /data-n-au="(https?:\/\/[^"]+)"/i
    );

    if (dataMatch?.[1]) {
      return dataMatch[1];
    }

    // Generic href fallback
    const hrefMatch = html.match(
      /href="(https?:\/\/(?!news\.google\.com)[^"]+)"/i
    );

    if (hrefMatch?.[1]) {
      return hrefMatch[1];
    }

    return googleUrl;
  } catch (err) {
    console.warn('Resolve failed:', err.message);
    return googleUrl;
  }
}

// ============================================================
// META SCRAPER
// ============================================================

async function fetchPageMeta(url) {
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
      console.warn('Meta fetch bad status:', res.status);
      return {};
    }

    const reader = res.body.getReader();

    const decoder = new TextDecoder(
      'utf-8',
      { fatal: false }
    );

    let html = '';

    const MAX = 150 * 1024;

    while (html.length < MAX) {
      const { value, done } = await reader.read();

      if (done) break;

      html += decoder.decode(value, {
        stream: true
      });

      if (html.includes('</head>')) break;
    }

    try {
      reader.cancel();
    } catch {}

    const finalUrl = res.url || url;

    const grab = (...patterns) => {
      for (const p of patterns) {
        const m = html.match(p);

        if (m?.[1]) {
          return decodeEntities(
            m[1].trim()
          );
        }
      }

      return '';
    };

    // ========================================================
    // IMAGE EXTRACTION
    // ========================================================

    const image = grab(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,

      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,

      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,

      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,

      /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,

      /<img[^>]+src=["']([^"']+)["']/i
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

    let resolvedImage = image;

    // Resolve relative image URLs
    if (
      resolvedImage &&
      !resolvedImage.startsWith('http')
    ) {
      try {
        resolvedImage = new URL(
          resolvedImage,
          finalUrl
        ).href;
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
    console.warn(
      'Meta fetch failed:',
      err.message
    );

    return {};
  }
}

// ============================================================
// ROOT
// ============================================================

app.get('/', (req, res) => {
  res.json({
    name: 'Dispatch Server',
    status: 'ok',
    endpoints: [
      '/feed?url=<rss_url>',
      '/meta?url=<article_url>',
      '/health'
    ]
  });
});

// ============================================================
// HEALTH
// ============================================================

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    metaCacheSize: metaCache.size,
    feedCacheSize: feedCache.size,
    uptime: process.uptime()
  });
});

// ============================================================
// FEED
// ============================================================

app.get('/feed', async (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({
      error: 'Missing url param'
    });
  }

  // cache
  const cached = feedCache.get(url);

  if (
    cached &&
    Date.now() - cached.t < FEED_TTL
  ) {
    return res.json({
      cached: true,
      items: cached.items
    });
  }

  try {
    const r = await fetch(url, {
      headers: {
        ...BROWSER_HEADERS,

        'Accept':
          'application/rss+xml, application/xml, text/xml;q=0.9,*/*;q=0.8'
      },

      redirect: 'follow',

      signal: AbortSignal.timeout(10000)
    });

    if (!r.ok) {
      return res.status(502).json({
        error: `Feed returned ${r.status}`
      });
    }

    const xml = await r.text();

    const parsed = await parser.parseString(xml);

    const items = (parsed.items || []).map(
      item => ({
        title: stripTags(
          item.title || ''
        ),

        link: item.link || '',

        pubDate:
          item.pubDate || '',

        source:
          item.creator ||
          item.author ||
          parsed.title ||
          'News',

        description: stripTags(
          item.contentSnippet ||
            item.content ||
            item.summary ||
            ''
        )
      })
    );

    feedCache.set(url, {
      t: Date.now(),
      items
    });

    res.json({
      cached: false,
      items
    });
  } catch (err) {
    console.error('Feed error:', err);

    res.status(500).json({
      error: err.message
    });
  }
});

// ============================================================
// META
// ============================================================

app.get('/meta', async (req, res) => {
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({
      error: 'Missing url param'
    });
  }

  // cache
  const cached = metaCache.get(url);

  if (
    cached &&
    Date.now() - cached.t < META_TTL
  ) {
    return res.json({
      cached: true,
      ...cached.data
    });
  }

  try {
    let targetUrl = url;

    // Resolve Google News redirects
    if (
      url.includes('news.google.com')
    ) {
      targetUrl =
        await resolveGoogleRedirect(url);
    }

    const meta =
      await fetchPageMeta(targetUrl);

    const data = {
      originalUrl: url,

      resolvedUrl:
        meta.finalUrl || targetUrl,

      image: meta.image || '',

      description:
        meta.description || '',

      ogTitle:
        meta.ogTitle || '',

      siteName:
        meta.siteName || ''
    };

    metaCache.set(url, {
      t: Date.now(),
      data
    });

    res.json({
      cached: false,
      ...data
    });
  } catch (err) {
    console.error('Meta error:', err);

    res.status(500).json({
      error: err.message
    });
  }
});

// ============================================================
// CACHE CLEANUP
// ============================================================

setInterval(() => {
  const now = Date.now();

  for (const [k, v] of metaCache.entries()) {
    if (now - v.t > META_TTL) {
      metaCache.delete(k);
    }
  }

  for (const [k, v] of feedCache.entries()) {
    if (now - v.t > FEED_TTL) {
      feedCache.delete(k);
    }
  }
}, 1000 * 60 * 10);

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(
    `Dispatch server listening on :${PORT}`
  );
});
