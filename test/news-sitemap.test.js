const test = require('node:test');
const assert = require('node:assert/strict');

const { parseNewsSitemap } = require('../src/news-sitemap');

test('Google News Sitemap entries map to feed items', () => {
  const sourceUrl = 'https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml';
  const parsed = parseNewsSitemap(`<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
      xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"
      xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
      <url>
        <loc>https://www.reuters.com/world/example-story-2026-08-01/</loc>
        <lastmod>2026-08-01T01:02:04.000Z</lastmod>
        <news:news>
          <news:publication>
            <news:name>Reuters</news:name>
            <news:language>en</news:language>
          </news:publication>
          <news:publication_date>2026-08-01T01:02:03.000Z</news:publication_date>
          <news:title><![CDATA[Markets rise & investors react]]></news:title>
        </news:news>
        <image:image>
          <image:loc>https://www.reuters.com/resizer/example.jpg</image:loc>
        </image:image>
      </url>
    </urlset>`, sourceUrl);

  assert.equal(parsed.title, 'Reuters');
  assert.equal(parsed.link, 'https://www.reuters.com/');
  assert.deepEqual(parsed.items, [
    {
      guid: 'https://www.reuters.com/world/example-story-2026-08-01/',
      title: 'Markets rise & investors react',
      link: 'https://www.reuters.com/world/example-story-2026-08-01/',
      isoDate: '2026-08-01T01:02:03.000Z',
    },
  ]);
});

test('non-news feeds and malformed XML fall through to the RSS parser', () => {
  const sourceUrl = 'https://example.com/feed.xml';
  const newsNamespace = 'http://www.google.com/schemas/sitemap-news/0.9';

  assert.equal(parseNewsSitemap('<rss version="2.0"><channel /></rss>', sourceUrl), null);
  assert.equal(parseNewsSitemap(`<?xml version="1.0"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/article</loc></url>
    </urlset>`, sourceUrl), null);
  assert.equal(parseNewsSitemap(`<urlset xmlns:news="${newsNamespace}"><url>`, sourceUrl), null);
  assert.equal(parseNewsSitemap(`<rss xmlns:news="${newsNamespace}" />`, sourceUrl), null);

  assert.deepEqual(parseNewsSitemap(`<?xml version="1.0"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="${newsNamespace}">
      <url><news:news><news:title>Missing link</news:title></news:news></url>
      <url><loc>https://example.com/missing-news</loc></url>
    </urlset>`, sourceUrl), {
    title: 'example.com',
    link: 'https://example.com/',
    items: [],
  });
});

test('News Sitemap filters prefer URL locale prefixes and normalize Breakingviews', () => {
  const sourceUrl = 'https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
      xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
      <url>
        <loc>https://www.reuters.com/world/english-story-2026-08-01/</loc>
        <news:news><news:publication><news:name>Reuters</news:name><news:language>pt</news:language></news:publication><news:title>World</news:title></news:news>
      </url>
      <url>
        <loc>https://www.reuters.com/pt/desportivo/portuguese-story-2026-08-01/</loc>
        <news:news><news:publication><news:name>Reuters</news:name><news:language>en</news:language></news:publication><news:title>Portuguese</news:title></news:news>
      </url>
      <url>
        <loc>https://www.reuters.com/sports/english-sports-story-2026-08-01/</loc>
        <news:news><news:publication><news:name>Reuters</news:name><news:language>en</news:language></news:publication><news:title>Sports</news:title></news:news>
      </url>
      <url>
        <loc>https://www.reuters.com/commentary/breakingviews/english-commentary-2026-08-01/</loc>
        <news:news><news:publication><news:name>Reuters</news:name><news:language>en</news:language></news:publication><news:title>Breakingviews</news:title></news:news>
      </url>
      <url>
        <loc>https://example.com/it/information-technology-story</loc>
        <news:news><news:publication><news:name>Example</news:name><news:language>en</news:language></news:publication><news:title>Other site IT</news:title></news:news>
      </url>
      <url>
        <loc>/world/relative-story/</loc>
        <news:news><news:publication><news:name>Reuters</news:name><news:language>en</news:language></news:publication><news:title>Invalid relative URL</news:title></news:news>
      </url>
    </urlset>`;

  const selected = parseNewsSitemap(xml, sourceUrl, {
    languages: ['en'],
    sections: ['world', 'business', 'technology', 'markets'],
  });
  assert.deepEqual(selected.items.map((item) => item.title), ['World']);

  const portuguese = parseNewsSitemap(xml, sourceUrl, { languages: ['pt'] });
  assert.deepEqual(portuguese.items.map((item) => item.title), ['Portuguese']);

  const english = parseNewsSitemap(xml, sourceUrl, { languages: ['en'] });
  assert.deepEqual(english.items.map((item) => item.title), [
    'World',
    'Sports',
    'Breakingviews',
    'Other site IT',
  ]);

  const breakingviews = parseNewsSitemap(xml, sourceUrl, {
    languages: ['en'],
    sections: ['breakingviews'],
  });
  assert.deepEqual(breakingviews.items.map((item) => item.title), ['Breakingviews']);

  const noMatches = parseNewsSitemap(xml, sourceUrl, {
    languages: ['en'],
    sections: ['technology'],
  });
  assert.equal(noMatches.title, 'Reuters');
  assert.deepEqual(noMatches.items, []);
});

test('News Sitemap items are ordered by publication date before refresh limits apply', () => {
  const sourceUrl = 'https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml';
  const parsed = parseNewsSitemap(`<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
      xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
      <url>
        <loc>https://www.reuters.com/world/older-story/</loc>
        <news:news><news:publication><news:name>Reuters</news:name><news:language>en</news:language></news:publication><news:publication_date>2026-08-01T01:00:00.000Z</news:publication_date><news:title>Older</news:title></news:news>
      </url>
      <url>
        <loc>https://www.reuters.com/world/newer-story/</loc>
        <news:news><news:publication><news:name>Reuters</news:name><news:language>en</news:language></news:publication><news:publication_date>2026-08-01T02:00:00.000Z</news:publication_date><news:title>Newer</news:title></news:news>
      </url>
      <url>
        <loc>https://www.reuters.com/world/undated-story/</loc>
        <news:news><news:publication><news:name>Reuters</news:name><news:language>en</news:language></news:publication><news:title>Undated</news:title></news:news>
      </url>
      <url>
        <loc>https://www.reuters.com/world/invalid-date-story/</loc>
        <news:news><news:publication><news:name>Reuters</news:name><news:language>en</news:language></news:publication><news:publication_date>not-a-date</news:publication_date><news:title>Invalid date</news:title></news:news>
      </url>
    </urlset>`, sourceUrl);

  assert.deepEqual(parsed.items.map((item) => item.title), [
    'Newer',
    'Older',
    'Undated',
    'Invalid date',
  ]);
});
