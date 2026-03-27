function coerceArticleEntity(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value;
  if (
    typeof candidate.title === 'string' ||
    typeof candidate.plain_text === 'string' ||
    typeof candidate.preview_text === 'string' ||
    candidate.content_state
  ) {
    return candidate;
  }

  return null;
}

function escapeMarkdownAlt(text) {
  return text.replace(/[\[\]]/g, '\\$&');
}

function normalizeCaption(caption) {
  const trimmed = caption?.trim();
  if (!trimmed) {
    return '';
  }

  return trimmed.replace(/\s+/g, ' ');
}

function summarizeTweetText(text) {
  const trimmed = text?.trim();
  if (!trimmed) {
    return '';
  }

  const normalized = trimmed
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');

  return normalized.length <= 280 ? normalized : `${normalized.slice(0, 277)}...`;
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

function buildEntityLookup(entityMap) {
  const lookup = {
    byIndex: new Map(),
    byLogicalKey: new Map(),
  };
  if (!entityMap) {
    return lookup;
  }

  for (const [idx, entry] of Object.entries(entityMap)) {
    const idxNum = Number(idx);
    if (Number.isFinite(idxNum)) {
      lookup.byIndex.set(idxNum, entry);
    }

    const logicalKey = Number.parseInt(entry?.key ?? '', 10);
    if (Number.isFinite(logicalKey) && !lookup.byLogicalKey.has(logicalKey)) {
      lookup.byLogicalKey.set(logicalKey, entry);
    }
  }

  return lookup;
}

function resolveEntityEntry(entityKey, entityMap, lookup) {
  if (entityKey === undefined) {
    return undefined;
  }

  return lookup.byLogicalKey.get(entityKey) || lookup.byIndex.get(entityKey) || entityMap?.[String(entityKey)];
}

function resolveVideoUrl(info) {
  if (!info) {
    return undefined;
  }

  const variants = info.variants ?? [];
  const mp4 = variants
    .filter((variant) => variant?.content_type?.includes('video'))
    .sort((left, right) => (right.bit_rate ?? 0) - (left.bit_rate ?? 0))[0];
  return mp4?.url ?? variants.find((variant) => typeof variant?.url === 'string')?.url;
}

function resolveMediaAsset(info) {
  if (!info) {
    return undefined;
  }

  const posterUrl = info.preview_image?.original_img_url ?? info.original_img_url;
  const videoUrl = resolveVideoUrl(info);
  if (videoUrl) {
    return {
      kind: 'video',
      url: videoUrl,
      posterUrl,
    };
  }

  const imageUrl = info.original_img_url ?? info.preview_image?.original_img_url;
  if (imageUrl) {
    return {
      kind: 'image',
      url: imageUrl,
    };
  }

  return undefined;
}

function resolveFallbackMediaAsset(rawUrl) {
  if (!rawUrl) {
    return undefined;
  }

  if (/^https:\/\/video\.twimg\.com\//i.test(rawUrl) || /\.(mp4|m4v|mov|webm)(?:$|[?#])/i.test(rawUrl)) {
    return {
      kind: 'video',
      url: rawUrl,
    };
  }

  return {
    kind: 'image',
    url: rawUrl,
  };
}

function buildMediaIdentity(asset) {
  return asset.kind === 'video' ? `video:${asset.url}:${asset.posterUrl ?? ''}` : `image:${asset.url}`;
}

function renderMediaLines(asset, altText, usedUrls) {
  if (asset.kind === 'video') {
    const lines = [];
    if (asset.posterUrl && !usedUrls.has(asset.posterUrl)) {
      usedUrls.add(asset.posterUrl);
      lines.push(`![${altText || 'video'}](${asset.posterUrl})`);
    }
    if (!usedUrls.has(asset.url)) {
      usedUrls.add(asset.url);
      lines.push(`[video](${asset.url})`);
    }
    return lines;
  }

  if (usedUrls.has(asset.url)) {
    return [];
  }

  usedUrls.add(asset.url);
  return [`![${altText}](${asset.url})`];
}

function buildMediaById(article) {
  const map = new Map();
  for (const entity of article.media_entities ?? []) {
    if (!entity?.media_id) {
      continue;
    }
    const asset = resolveMediaAsset(entity.media_info);
    if (asset) {
      map.set(entity.media_id, asset);
    }
  }
  return map;
}

function collectMediaAssets(article) {
  const assets = [];
  const seen = new Set();
  const addAsset = (asset) => {
    if (!asset) {
      return;
    }
    const identity = buildMediaIdentity(asset);
    if (seen.has(identity)) {
      return;
    }
    seen.add(identity);
    assets.push(asset);
  };

  for (const entity of article.media_entities ?? []) {
    addAsset(resolveMediaAsset(entity?.media_info));
  }

  return assets;
}

function resolveEntityMediaLines(entityKey, entityMap, lookup, mediaById, usedUrls) {
  if (entityKey === undefined) {
    return [];
  }

  const entry = resolveEntityEntry(entityKey, entityMap, lookup);
  const value = entry?.value;
  if (!value || (value.type !== 'MEDIA' && value.type !== 'IMAGE')) {
    return [];
  }

  const caption = normalizeCaption(value.data?.caption);
  const altText = caption ? escapeMarkdownAlt(caption) : '';
  const lines = [];

  for (const item of value.data?.mediaItems ?? []) {
    const mediaId =
      typeof item?.mediaId === 'string'
        ? item.mediaId
        : typeof item?.media_id === 'string'
          ? item.media_id
          : undefined;
    const asset = mediaId ? mediaById.get(mediaId) : undefined;
    if (asset) {
      lines.push(...renderMediaLines(asset, altText, usedUrls));
    }
  }

  const fallbackUrl = typeof value.data?.url === 'string' ? value.data.url : undefined;
  const fallbackAsset = resolveFallbackMediaAsset(fallbackUrl);
  if (fallbackAsset) {
    lines.push(...renderMediaLines(fallbackAsset, altText, usedUrls));
  }

  return lines;
}

function resolveEntityTweetLines(entityKey, entityMap, lookup, referencedTweets) {
  if (entityKey === undefined) {
    return [];
  }

  const entry = resolveEntityEntry(entityKey, entityMap, lookup);
  const value = entry?.value;
  if (!value || value.type !== 'TWEET') {
    return [];
  }

  const tweetId = typeof value.data?.tweetId === 'string' ? value.data.tweetId : '';
  if (!tweetId) {
    return [];
  }

  const referenced = referencedTweets?.get(tweetId);
  const url =
    referenced?.url ??
    buildTweetUrl(referenced?.authorUsername, tweetId) ??
    `https://x.com/i/web/status/${tweetId}`;
  const authorText =
    referenced?.authorName && referenced?.authorUsername
      ? `${referenced.authorName} (@${referenced.authorUsername})`
      : referenced?.authorUsername
        ? `@${referenced.authorUsername}`
        : referenced?.authorName;

  const lines = [];
  lines.push(`> 引用推文${authorText ? `：${authorText}` : ''}`);
  const summary = summarizeTweetText(referenced?.text);
  if (summary) {
    lines.push(`> ${summary}`);
  }
  lines.push(`> ${url}`);
  return lines;
}

function resolveEntityMarkdownLines(entityKey, entityMap, lookup) {
  if (entityKey === undefined) {
    return [];
  }

  const entry = resolveEntityEntry(entityKey, entityMap, lookup);
  const value = entry?.value;
  if (!value || value.type !== 'MARKDOWN') {
    return [];
  }

  const markdownValue = typeof value.data?.markdown === 'string' ? value.data.markdown : '';
  const normalized = markdownValue.replace(/\r\n/g, '\n').trimEnd();
  if (!normalized) {
    return [];
  }

  return normalized.split('\n');
}

function buildMediaLinkMap(entityMap) {
  const map = new Map();
  if (!entityMap) {
    return map;
  }

  const mediaEntries = [];
  const linkEntries = [];

  for (const [idx, entry] of Object.entries(entityMap)) {
    const value = entry?.value;
    const key = Number.parseInt(entry?.key ?? '', 10);
    if (!value || Number.isNaN(key)) {
      continue;
    }

    if (value.type === 'MEDIA' || value.type === 'IMAGE') {
      mediaEntries.push({ idx: Number(idx), key });
    } else if (value.type === 'LINK' && typeof value.data?.url === 'string') {
      linkEntries.push({ key, url: value.data.url });
    }
  }

  mediaEntries.sort((left, right) => left.key - right.key);
  linkEntries.sort((left, right) => left.key - right.key);

  const pool = [...linkEntries];
  for (const media of mediaEntries) {
    if (!pool.length) {
      break;
    }
    let linkIdx = pool.findIndex((item) => item.key > media.key);
    if (linkIdx === -1) {
      linkIdx = 0;
    }
    const link = pool.splice(linkIdx, 1)[0];
    map.set(media.idx, link.url);
    map.set(media.key, link.url);
  }

  return map;
}

function renderInlineLinks(text, entityRanges, entityMap, lookup, mediaLinkMap) {
  if (!entityMap || !entityRanges.length) {
    return text;
  }

  const valid = entityRanges.filter(
    (range) =>
      typeof range.key === 'number' &&
      typeof range.offset === 'number' &&
      typeof range.length === 'number' &&
      range.length > 0
  );
  if (!valid.length) {
    return text;
  }

  const sorted = [...valid].sort((left, right) => (right.offset ?? 0) - (left.offset ?? 0));
  let result = text;
  for (const range of sorted) {
    const entry = resolveEntityEntry(range.key, entityMap, lookup);
    const value = entry?.value;
    if (!value) {
      continue;
    }

    let url;
    if (value.type === 'LINK' && typeof value.data?.url === 'string') {
      url = value.data.url;
    } else if (value.type === 'MEDIA' || value.type === 'IMAGE') {
      url = mediaLinkMap.get(range.key);
    }
    if (!url) {
      continue;
    }

    const linkText = result.slice(range.offset, range.offset + range.length);
    result = `${result.slice(0, range.offset)}[${linkText}](${url})${result.slice(range.offset + range.length)}`;
  }

  return result;
}

function renderContentBlocks(blocks, entityMap, lookup, mediaById, usedUrls, mediaLinkMap, referencedTweets) {
  const lines = [];
  let previousKind = null;
  let listKind = null;
  let orderedIndex = 0;
  let inCodeBlock = false;

  const pushBlock = (blockLines, kind) => {
    if (!blockLines.length) {
      return;
    }
    if (
      lines.length &&
      previousKind &&
      !(previousKind === kind && (kind === 'list' || kind === 'quote' || kind === 'media'))
    ) {
      lines.push('');
    }
    lines.push(...blockLines);
    previousKind = kind;
  };

  const collectMediaLines = (block) => {
    const mediaLines = [];
    for (const range of block.entityRanges ?? []) {
      if (typeof range?.key !== 'number') {
        continue;
      }
      mediaLines.push(...resolveEntityMediaLines(range.key, entityMap, lookup, mediaById, usedUrls));
    }
    return mediaLines;
  };

  const collectTweetLines = (block) => {
    const tweetLines = [];
    for (const range of block.entityRanges ?? []) {
      if (typeof range?.key !== 'number') {
        continue;
      }
      tweetLines.push(...resolveEntityTweetLines(range.key, entityMap, lookup, referencedTweets));
    }
    return tweetLines;
  };

  const collectLinkLines = (block) => {
    const linkLines = [];
    for (const range of block.entityRanges ?? []) {
      if (typeof range?.key !== 'number') {
        continue;
      }
      const entry = resolveEntityEntry(range.key, entityMap, lookup);
      const url = entry?.value?.type === 'LINK' && typeof entry.value.data?.url === 'string'
        ? entry.value.data.url
        : '';
      if (url) {
        linkLines.push(url);
      }
    }
    return [...new Set(linkLines)];
  };

  const collectMarkdownLines = (block) => {
    const markdownLines = [];
    for (const range of block.entityRanges ?? []) {
      if (typeof range?.key !== 'number') {
        continue;
      }
      markdownLines.push(...resolveEntityMarkdownLines(range.key, entityMap, lookup));
    }
    return markdownLines;
  };

  const pushTrailingMedia = (mediaLines) => {
    if (mediaLines.length) {
      pushBlock(mediaLines, 'media');
    }
  };

  for (const block of blocks) {
    const type = typeof block?.type === 'string' ? block.type : 'unstyled';
    const rawText = typeof block?.text === 'string' ? block.text : '';
    const ranges = Array.isArray(block?.entityRanges) ? block.entityRanges : [];
    const text =
      type !== 'atomic' && type !== 'code-block'
        ? renderInlineLinks(rawText, ranges, entityMap, lookup, mediaLinkMap)
        : rawText;

    if (type === 'code-block') {
      if (!inCodeBlock) {
        if (lines.length) {
          lines.push('');
        }
        lines.push('```');
        inCodeBlock = true;
      }
      lines.push(text);
      previousKind = 'code';
      listKind = null;
      orderedIndex = 0;
      continue;
    }

    if (type === 'atomic') {
      if (inCodeBlock) {
        lines.push('```');
        inCodeBlock = false;
        previousKind = 'code';
      }
      listKind = null;
      orderedIndex = 0;

      const tweetLines = collectTweetLines(block);
      if (tweetLines.length) {
        pushBlock(tweetLines, 'quote');
      }

      const markdownLines = collectMarkdownLines(block);
      if (markdownLines.length) {
        pushBlock(markdownLines, 'text');
      }

      const mediaLines = collectMediaLines(block);
      if (mediaLines.length) {
        pushBlock(mediaLines, 'media');
      }

      const linkLines = collectLinkLines(block);
      if (linkLines.length) {
        pushBlock(linkLines, 'text');
      }
      continue;
    }

    if (inCodeBlock) {
      lines.push('```');
      inCodeBlock = false;
      previousKind = 'code';
    }

    if (type === 'unordered-list-item') {
      listKind = 'unordered';
      orderedIndex = 0;
      pushBlock([`- ${text}`], 'list');
      pushTrailingMedia(collectMediaLines(block));
      continue;
    }

    if (type === 'ordered-list-item') {
      if (listKind !== 'ordered') {
        orderedIndex = 0;
      }
      listKind = 'ordered';
      orderedIndex += 1;
      pushBlock([`${orderedIndex}. ${text}`], 'list');
      pushTrailingMedia(collectMediaLines(block));
      continue;
    }

    listKind = null;
    orderedIndex = 0;

    switch (type) {
      case 'header-one':
        pushBlock([`# ${text}`], 'heading');
        pushTrailingMedia(collectMediaLines(block));
        break;
      case 'header-two':
        pushBlock([`## ${text}`], 'heading');
        pushTrailingMedia(collectMediaLines(block));
        break;
      case 'header-three':
        pushBlock([`### ${text}`], 'heading');
        pushTrailingMedia(collectMediaLines(block));
        break;
      case 'header-four':
        pushBlock([`#### ${text}`], 'heading');
        pushTrailingMedia(collectMediaLines(block));
        break;
      case 'header-five':
        pushBlock([`##### ${text}`], 'heading');
        pushTrailingMedia(collectMediaLines(block));
        break;
      case 'header-six':
        pushBlock([`###### ${text}`], 'heading');
        pushTrailingMedia(collectMediaLines(block));
        break;
      case 'blockquote': {
        const quoteLines = text.length ? text.split('\n') : [''];
        pushBlock(quoteLines.map((line) => `> ${line}`), 'quote');
        pushTrailingMedia(collectMediaLines(block));
        break;
      }
      default:
        if (/^XIMGPH_\d+$/.test(text.trim())) {
          pushTrailingMedia(collectMediaLines(block));
          break;
        }
        pushBlock([text], 'text');
        pushTrailingMedia(collectMediaLines(block));
        break;
    }
  }

  if (inCodeBlock) {
    lines.push('```');
  }

  return lines;
}

function extractReferencedTweetIds(article) {
  const candidate = coerceArticleEntity(article);
  const entityMap = candidate?.content_state?.entityMap;
  if (!entityMap) {
    return [];
  }

  const ids = [];
  const seen = new Set();
  for (const entry of Object.values(entityMap)) {
    const tweetId = entry?.value?.type === 'TWEET' && typeof entry.value.data?.tweetId === 'string'
      ? entry.value.data.tweetId
      : '';
    if (!tweetId || seen.has(tweetId)) {
      continue;
    }
    seen.add(tweetId);
    ids.push(tweetId);
  }
  return ids;
}

function formatArticleMarkdown(article, options = {}) {
  const candidate = coerceArticleEntity(article);
  if (!candidate) {
    return { markdown: `\`\`\`json\n${JSON.stringify(article, null, 2)}\n\`\`\``, coverUrl: null };
  }

  const lines = [];
  const usedUrls = new Set();
  const mediaById = buildMediaById(candidate);
  const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
  if (title) {
    lines.push(`# ${title}`);
  }

  const coverUrl = candidate.cover_media?.media_info?.original_img_url ?? candidate.cover_media?.media_info?.preview_image?.original_img_url ?? null;
  if (coverUrl) {
    usedUrls.add(coverUrl);
  }

  const blocks = candidate.content_state?.blocks;
  const entityMap = candidate.content_state?.entityMap;
  const lookup = buildEntityLookup(entityMap);
  if (Array.isArray(blocks) && blocks.length) {
    const mediaLinkMap = buildMediaLinkMap(entityMap);
    const rendered = renderContentBlocks(
      blocks,
      entityMap,
      lookup,
      mediaById,
      usedUrls,
      mediaLinkMap,
      options.referencedTweets
    );
    if (rendered.length) {
      if (lines.length) {
        lines.push('');
      }
      lines.push(...rendered);
    }
  } else if (typeof candidate.plain_text === 'string') {
    if (lines.length) {
      lines.push('');
    }
    lines.push(candidate.plain_text.trim());
  } else if (typeof candidate.preview_text === 'string') {
    if (lines.length) {
      lines.push('');
    }
    lines.push(candidate.preview_text.trim());
  }

  const trailingMediaLines = [];
  for (const asset of collectMediaAssets(candidate)) {
    trailingMediaLines.push(...renderMediaLines(asset, '', usedUrls));
  }
  if (trailingMediaLines.length) {
    lines.push('', '## Media', '', ...trailingMediaLines);
  }

  return {
    markdown: lines.join('\n').trimEnd(),
    coverUrl,
  };
}

function normalizeAlt(text) {
  const trimmed = text?.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/\s+/g, ' ');
}

function parseTweetText(tweet) {
  return (tweet?.note_tweet?.note_tweet_results?.result?.text ?? tweet?.legacy?.full_text ?? tweet?.legacy?.text ?? '').trim();
}

function parsePhotos(tweet) {
  const photos = [];
  for (const item of tweet?.legacy?.extended_entities?.media ?? []) {
    if (item?.type !== 'photo') {
      continue;
    }
    const src = item.media_url_https ?? item.media_url;
    if (!src) {
      continue;
    }
    photos.push({
      src,
      alt: normalizeAlt(item.ext_alt_text),
    });
  }
  return photos;
}

function parseVideos(tweet) {
  const videos = [];
  for (const item of tweet?.legacy?.extended_entities?.media ?? []) {
    if (!item?.type || !['animated_gif', 'video'].includes(item.type)) {
      continue;
    }
    const sources = (item?.video_info?.variants ?? [])
      .map((variant) => ({
        contentType: variant?.content_type,
        url: variant?.url,
        bitrate: variant?.bitrate ?? 0,
      }))
      .filter((variant) => Boolean(variant.url));
    const videoSources = sources.filter((variant) => String(variant.contentType ?? '').includes('video'));
    const best = (videoSources.length ? videoSources : sources).sort((left, right) => (right.bitrate ?? 0) - (left.bitrate ?? 0))[0];
    if (!best?.url) {
      continue;
    }
    videos.push({
      url: best.url,
      poster: item.media_url_https ?? item.media_url ?? undefined,
      alt: normalizeAlt(item.ext_alt_text),
      type: item.type,
    });
  }
  return videos;
}

function unwrapTweetResult(result) {
  if (!result) {
    return null;
  }
  if (result.__typename === 'TweetWithVisibilityResults' && result.tweet) {
    return result.tweet;
  }
  return result;
}

function resolveTweetId(tweet) {
  return tweet?.legacy?.id_str ?? tweet?.rest_id;
}

function formatQuotedTweetMarkdown(quoted) {
  if (!quoted) {
    return [];
  }

  const quotedUser = quoted?.core?.user_results?.result?.legacy;
  const quotedUsername = quotedUser?.screen_name;
  const quotedName = quotedUser?.name;
  const quotedAuthor =
    quotedUsername && quotedName
      ? `${quotedName} (@${quotedUsername})`
      : quotedUsername
        ? `@${quotedUsername}`
        : quotedName ?? 'Unknown';
  const quotedId = resolveTweetId(quoted);
  const quotedUrl = buildTweetUrl(quotedUsername, quotedId) ?? (quotedId ? `https://x.com/i/web/status/${quotedId}` : 'unavailable');
  const quotedText = parseTweetText(quoted);
  const lines = [`Author: ${quotedAuthor}`, `URL: ${quotedUrl}`];
  if (quotedText) {
    lines.push('', ...quotedText.split(/\r?\n/));
  } else {
    lines.push('', '(no content)');
  }
  return lines.map((line) => `> ${line}`.trimEnd());
}

function formatThreadTweetsMarkdown(tweets, options = {}) {
  if (!Array.isArray(tweets) || !tweets.length) {
    return '';
  }

  const headingLevel = options.headingLevel ?? 2;
  const includeTweetUrls = options.includeTweetUrls ?? true;
  const startIndex = options.startIndex ?? 1;
  const includeIndexHeading = options.includeIndexHeading ?? tweets.length > 1;
  const headingPrefix = '#'.repeat(Math.min(Math.max(headingLevel, 1), 6));
  const chunks = [];

  tweets.forEach((tweet, index) => {
    const tweetId = resolveTweetId(tweet);
    const tweetUrl = includeTweetUrls ? buildTweetUrl(options.username, tweetId) : null;
    const lines = [];
    if (includeIndexHeading) {
      lines.push(`${headingPrefix} ${startIndex + index}`);
    }
    if (tweetUrl) {
      lines.push(tweetUrl);
    }
    if (includeIndexHeading || tweetUrl) {
      lines.push('');
    }

    const bodyLines = [];
    const text = parseTweetText(tweet);
    if (text) {
      bodyLines.push(...text.split(/\r?\n/));
    }

    const quoted = unwrapTweetResult(tweet?.quoted_status_result?.result);
    const quotedLines = formatQuotedTweetMarkdown(quoted);
    if (quotedLines.length) {
      if (bodyLines.length) {
        bodyLines.push('');
      }
      bodyLines.push(...quotedLines);
    }

    const photoLines = parsePhotos(tweet).map((photo) => `![${photo.alt ? escapeMarkdownAlt(photo.alt) : ''}](${photo.src})`);
    if (photoLines.length) {
      if (bodyLines.length) {
        bodyLines.push('');
      }
      bodyLines.push(...photoLines);
    }

    const videoLines = [];
    for (const video of parseVideos(tweet)) {
      if (video.poster) {
        videoLines.push(`![${video.alt ? escapeMarkdownAlt(video.alt) : 'video'}](${video.poster})`);
      }
      videoLines.push(`[${video.type ?? 'video'}](${video.url})`);
    }
    if (videoLines.length) {
      if (bodyLines.length) {
        bodyLines.push('');
      }
      bodyLines.push(...videoLines);
    }

    if (!bodyLines.length) {
      bodyLines.push('_No text or media._');
    }

    lines.push(...bodyLines);
    chunks.push(lines.join('\n').trimEnd());
  });

  return chunks.join('\n\n').trimEnd();
}

function formatThreadMarkdown(thread, options = {}) {
  if (!thread || !Array.isArray(thread.tweets)) {
    return `\`\`\`json\n${JSON.stringify(thread, null, 2)}\n\`\`\``;
  }

  const tweets = thread.tweets ?? [];
  const firstTweet = tweets[0];
  const user = thread.user ?? firstTweet?.core?.user_results?.result?.legacy;
  const username = user?.screen_name;
  const name = user?.name;
  const includeHeader = options.includeHeader ?? true;
  const lines = [];

  if (includeHeader) {
    if (options.title) {
      lines.push(`# ${options.title}`);
    } else if (username) {
      lines.push(`# Thread by @${username}${name ? ` (${name})` : ''}`);
    } else {
      lines.push('# Thread');
    }

    const sourceUrl = options.sourceUrl ?? buildTweetUrl(username, thread.rootId ?? thread.requestedId);
    if (sourceUrl) {
      lines.push(`Source: ${sourceUrl}`);
    }
    if (typeof thread.totalTweets === 'number') {
      lines.push(`Tweets: ${thread.totalTweets}`);
    }
  }

  const tweetMarkdown = formatThreadTweetsMarkdown(tweets, {
    ...options,
    username,
  });
  if (tweetMarkdown) {
    if (lines.length) {
      lines.push('');
    }
    lines.push(tweetMarkdown);
  }

  return lines.join('\n').trimEnd();
}

module.exports = {
  extractReferencedTweetIds,
  formatArticleMarkdown,
  formatThreadMarkdown,
  formatThreadTweetsMarkdown,
};
