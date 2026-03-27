const { loadXCookies, fetchXArticle, fetchXTweet } = require('./x-client');
const { formatArticleMarkdown, formatThreadTweetsMarkdown, extractReferencedTweetIds } = require('./x-format');
const { fetchTweetThread } = require('./x-thread');
const { normalizeWhitespace, truncate } = require('./utils');

function parseTweetId(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.pathname.match(/\/status(?:es)?\/(\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function parseArticleId(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.pathname.match(/\/(?:i\/)?article\/(\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function parseTweetUsername(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.pathname.match(/^\/([^/]+)\/status(?:es)?\/\d+/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function buildTweetUrl(username, tweetId) {
  if (!tweetId) {
    return null;
  }

  if (username) {
    return `https://x.com/${username}/status/${tweetId}`;
  }

  return `https://x.com/i/web/status/${tweetId}`;
}

function buildAuthor(user) {
  const username = user?.screen_name;
  const name = user?.name;
  if (username && name) {
    return `${name} (@${username})`;
  }
  if (username) {
    return `@${username}`;
  }
  return name ?? '';
}

function parseTweetText(tweet) {
  return (tweet?.note_tweet?.note_tweet_results?.result?.text ?? tweet?.legacy?.full_text ?? tweet?.legacy?.text ?? '').trim();
}

function isOnlyUrl(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return true;
  }

  return /^https?:\/\/\S+$/.test(trimmed);
}

function extractMarkdownTitle(markdown) {
  const match = String(markdown || '').match(/^\s*#\s+(.+?)\s*$/m);
  return match ? normalizeWhitespace(match[1]) : '';
}

function buildThreadTitle(thread) {
  const firstTweet = thread?.tweets?.[0];
  const base = normalizeWhitespace(parseTweetText(firstTweet));
  if (base) {
    return truncate(base, 100);
  }

  const username = thread?.user?.screen_name;
  return username ? `Thread by @${username}` : 'X Thread';
}

function parseIsoDate(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function extractArticleEntityFromTweet(tweet) {
  return (
    tweet?.article?.article_results?.result ??
    tweet?.article?.result ??
    tweet?.legacy?.article?.article_results?.result ??
    tweet?.legacy?.article?.result ??
    tweet?.article_results?.result ??
    null
  );
}

function extractArticleIdFromUrls(urls) {
  if (!Array.isArray(urls)) {
    return null;
  }

  for (const url of urls) {
    const candidate = url?.expanded_url ?? url?.url ?? (url?.display_url ? `https://${url.display_url}` : undefined);
    const id = parseArticleId(candidate);
    if (id) {
      return id;
    }
  }

  return null;
}

function extractArticleIdFromTweet(tweet) {
  const embeddedArticle = extractArticleEntityFromTweet(tweet);
  if (embeddedArticle?.rest_id) {
    return embeddedArticle.rest_id;
  }

  return (
    extractArticleIdFromUrls(tweet?.note_tweet?.note_tweet_results?.result?.entity_set?.urls) ??
    extractArticleIdFromUrls(tweet?.legacy?.entities?.urls)
  );
}

function hasArticleContent(article) {
  const blocks = article?.content_state?.blocks;
  if (Array.isArray(blocks) && blocks.length > 0) {
    return true;
  }
  if (typeof article?.plain_text === 'string' && article.plain_text.trim()) {
    return true;
  }
  if (typeof article?.preview_text === 'string' && article.preview_text.trim()) {
    return true;
  }
  return false;
}

async function resolveArticleEntityFromTweet(tweet, cookieMap, config) {
  if (!tweet) {
    return null;
  }

  const embedded = extractArticleEntityFromTweet(tweet);
  if (embedded && typeof embedded === 'object' && hasArticleContent(embedded)) {
    return embedded;
  }

  const articleId = extractArticleIdFromTweet(tweet);
  if (!articleId) {
    return embedded ?? null;
  }

  return (await fetchXArticle(articleId, cookieMap, config)) ?? embedded ?? null;
}

function extractReferencedTweetInfo(tweet, fallbackTweetId) {
  const userCore = tweet?.core?.user_results?.result?.core;
  const userLegacy = tweet?.core?.user_results?.result?.legacy;
  const authorName =
    typeof userCore?.name === 'string'
      ? userCore.name
      : typeof userLegacy?.name === 'string'
        ? userLegacy.name
        : undefined;
  const authorUsername =
    typeof userCore?.screen_name === 'string'
      ? userCore.screen_name
      : typeof userLegacy?.screen_name === 'string'
        ? userLegacy.screen_name
        : undefined;
  const text =
    tweet?.note_tweet?.note_tweet_results?.result?.text ??
    tweet?.legacy?.full_text ??
    tweet?.legacy?.text ??
    undefined;
  const tweetId = typeof tweet?.rest_id === 'string' && tweet.rest_id ? tweet.rest_id : fallbackTweetId;

  return {
    id: tweetId,
    url: authorUsername ? `https://x.com/${authorUsername}/status/${tweetId}` : `https://x.com/i/web/status/${tweetId}`,
    authorName,
    authorUsername,
    text: typeof text === 'string' ? text : undefined,
  };
}

async function resolveReferencedTweetsFromArticle(article, cookieMap, config) {
  const ids = extractReferencedTweetIds(article);
  const referencedTweets = new Map();

  for (const id of ids) {
    try {
      const tweet = await fetchXTweet(id, cookieMap, config);
      referencedTweets.set(id, extractReferencedTweetInfo(tweet, id));
    } catch {
      referencedTweets.set(id, {
        id,
        url: `https://x.com/i/web/status/${id}`,
      });
    }
  }

  return referencedTweets;
}

function buildThreadMeta(thread, requestUrl) {
  const firstTweet = thread?.tweets?.[0];
  const user = thread?.user ?? firstTweet?.core?.user_results?.result?.legacy;
  const username = user?.screen_name;
  const rootId = thread?.rootId ?? thread?.requestedId;

  return {
    user,
    author: buildAuthor(user),
    canonicalUrl: buildTweetUrl(username, rootId) ?? requestUrl,
    publishedAt: parseIsoDate(firstTweet?.legacy?.created_at),
  };
}

async function importThreadUrl({ url, title, config, cookieMap }) {
  const tweetId = parseTweetId(url);
  if (!tweetId) {
    throw new Error('Invalid X status URL');
  }

  const thread = await fetchTweetThread(tweetId, cookieMap, config);
  if (!thread || !Array.isArray(thread.tweets) || !thread.tweets.length) {
    throw new Error('X thread fetch returned no tweets');
  }

  const meta = buildThreadMeta(thread, url);
  const firstTweet = thread.tweets[0];
  const articleEntity = await resolveArticleEntityFromTweet(firstTweet, cookieMap, config);

  if (articleEntity) {
    const referencedTweets = await resolveReferencedTweetsFromArticle(articleEntity, cookieMap, config);
    const articleResult = formatArticleMarkdown(articleEntity, { referencedTweets });
    const parts = [];
    const articleMarkdown = articleResult.markdown.trimEnd();
    let remainingTweets = thread.tweets;

    if (articleMarkdown) {
      parts.push(articleMarkdown);
      if (isOnlyUrl(parseTweetText(firstTweet))) {
        remainingTweets = thread.tweets.slice(1);
      }
    }

    if (remainingTweets.length > 0) {
      if (parts.length) {
        parts.push('## Thread');
      }
      const username = meta.user?.screen_name ?? parseTweetUsername(url);
      const threadMarkdown = formatThreadTweetsMarkdown(remainingTweets, {
        username,
        headingLevel: parts.length ? 3 : 2,
        startIndex: 1,
        includeTweetUrls: true,
      });
      if (threadMarkdown) {
        parts.push(threadMarkdown);
      }
    }

    const finalMarkdown = parts.join('\n\n').trimEnd();
    return {
      sourceTitle: title || extractMarkdownTitle(finalMarkdown) || buildThreadTitle(thread),
      sourceAuthor: meta.author,
      sourcePublishedAt: meta.publishedAt,
      sourceUrl: meta.canonicalUrl,
      markdown: finalMarkdown,
    };
  }

  const finalTitle = title || buildThreadTitle(thread);
  const username = meta.user?.screen_name ?? parseTweetUsername(url);
  const threadBody = formatThreadTweetsMarkdown(thread.tweets, {
    username,
    headingLevel: 2,
    startIndex: 1,
    includeTweetUrls: thread.tweets.length > 1,
    includeIndexHeading: thread.tweets.length > 1,
  });
  return {
    sourceTitle: finalTitle,
    sourceAuthor: meta.author,
    sourcePublishedAt: meta.publishedAt,
    sourceUrl: meta.canonicalUrl,
    markdown: threadBody,
  };
}

async function importArticleUrl({ url, title, config, cookieMap }) {
  const articleId = parseArticleId(url);
  if (!articleId) {
    throw new Error('Invalid X article URL');
  }

  const article = await fetchXArticle(articleId, cookieMap, config);
  const referencedTweets = await resolveReferencedTweetsFromArticle(article, cookieMap, config);
  const articleResult = formatArticleMarkdown(article, { referencedTweets });
  const finalTitle = title || extractMarkdownTitle(articleResult.markdown) || 'X Article';

  return {
    sourceTitle: finalTitle,
    sourceAuthor: '',
    sourcePublishedAt: null,
    sourceUrl: url,
    markdown: articleResult.markdown,
  };
}

async function importXUrl({ url, title = '', config }) {
  const cookieMap = loadXCookies(config);
  const normalizedUrl = new URL(String(url || '').trim()).toString();
  const articleId = parseArticleId(normalizedUrl);
  const tweetId = parseTweetId(normalizedUrl);

  if (articleId && !tweetId) {
    return importArticleUrl({
      url: normalizedUrl,
      title,
      config,
      cookieMap,
    });
  }

  if (tweetId) {
    return importThreadUrl({
      url: normalizedUrl,
      title,
      config,
      cookieMap,
    });
  }

  throw new Error('unsupported X URL');
}

module.exports = {
  importXUrl,
};
