const { fetchTweetDetail } = require('./x-client');

function unwrapTweetResult(result) {
  if (!result) {
    return null;
  }

  if (result.__typename === 'TweetWithVisibilityResults' && result.tweet) {
    return result.tweet;
  }

  return result;
}

function extractTweetEntry(itemContent) {
  const result = itemContent?.tweet_results?.result;
  if (!result) {
    return null;
  }

  const resolved = unwrapTweetResult(result?.tweet ?? result);
  if (!resolved) {
    return null;
  }

  const user = resolved?.core?.user_results?.result?.legacy;
  return { tweet: resolved, user };
}

function parseInstruction(instruction) {
  const entries = [];
  let moreCursor;
  let topCursor;
  let bottomCursor;

  const parseItems = (items) => {
    for (const item of items ?? []) {
      const itemContent = item?.item?.itemContent ?? item?.itemContent;
      if (!itemContent) {
        continue;
      }

      if (
        itemContent.cursorType &&
        ['ShowMore', 'ShowMoreThreads'].includes(itemContent.cursorType) &&
        itemContent.itemType === 'TimelineTimelineCursor'
      ) {
        moreCursor = itemContent.value;
        continue;
      }

      const entry = extractTweetEntry(itemContent);
      if (entry) {
        entries.push(entry);
      }
    }
  };

  if (instruction?.moduleItems) {
    parseItems(instruction.moduleItems);
  }

  for (const entity of instruction?.entries ?? []) {
    if (entity?.content?.clientEventInfo?.component === 'you_might_also_like') {
      continue;
    }

    const { itemContent, items, cursorType, entryType, value } = entity?.content ?? {};
    if (cursorType === 'Bottom' && entryType === 'TimelineTimelineCursor') {
      bottomCursor = value;
    }
    if (itemContent?.cursorType === 'Bottom' && itemContent?.itemType === 'TimelineTimelineCursor') {
      bottomCursor = bottomCursor ?? itemContent.value;
    }
    if (cursorType === 'Top' && entryType === 'TimelineTimelineCursor') {
      topCursor = topCursor ?? value;
    }
    if (itemContent?.cursorType === 'Top' && itemContent?.itemType === 'TimelineTimelineCursor') {
      topCursor = topCursor ?? itemContent.value;
    }
    if (
      itemContent?.cursorType &&
      ['ShowMore', 'ShowMoreThreads'].includes(itemContent.cursorType) &&
      itemContent.itemType === 'TimelineTimelineCursor'
    ) {
      moreCursor = moreCursor ?? itemContent.value;
    }

    const entry = extractTweetEntry(itemContent);
    if (entry) {
      entries.push(entry);
    }

    if (items) {
      parseItems(items);
    }
  }

  return { entries, moreCursor, topCursor, bottomCursor };
}

function parseTweetsAndToken(response) {
  const instruction =
    response?.data?.threaded_conversation_with_injections_v2?.instructions?.find(
      (ins) => ins?.type === 'TimelineAddEntries' || ins?.type === 'TimelineAddToModule'
    ) ??
    response?.data?.threaded_conversation_with_injections?.instructions?.find(
      (ins) => ins?.type === 'TimelineAddEntries' || ins?.type === 'TimelineAddToModule'
    );

  return parseInstruction(instruction);
}

function toTimestamp(value) {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function fetchTweetThread(tweetId, cookieMap, config) {
  const responses = [];
  const res = await fetchTweetDetail(tweetId, cookieMap, config);
  responses.push(res);

  let { entries, moreCursor, topCursor, bottomCursor } = parseTweetsAndToken(res);
  if (!entries.length) {
    const errorMessage = res?.errors?.[0]?.message;
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    return null;
  }

  let allEntries = entries.slice();
  const root = allEntries.find((entry) => entry.tweet?.legacy?.id_str === tweetId);
  if (!root) {
    throw new Error('Can not fetch the root tweet');
  }

  const rootEntry = root.tweet.legacy;
  const isSameThread = (entry) => {
    const tweet = entry.tweet?.legacy;
    if (!tweet) {
      return false;
    }
    return (
      tweet.user_id_str === rootEntry.user_id_str &&
      tweet.conversation_id_str === rootEntry.conversation_id_str &&
      (tweet.id_str === rootEntry.id_str ||
        tweet.in_reply_to_user_id_str === rootEntry.user_id_str ||
        tweet.in_reply_to_status_id_str === rootEntry.conversation_id_str ||
        !tweet.in_reply_to_user_id_str)
    );
  };
  const inThread = (items) => items.some(isSameThread);

  let hasThread = inThread(entries);
  let maxRequestCount = 1000;
  let topHasThread = true;

  while (topCursor && topHasThread && maxRequestCount > 0) {
    const next = await fetchTweetDetail(tweetId, cookieMap, config, topCursor);
    responses.push(next);
    const parsed = parseTweetsAndToken(next);
    topHasThread = inThread(parsed.entries);
    topCursor = parsed.topCursor;
    allEntries = parsed.entries.concat(allEntries);
    maxRequestCount -= 1;
  }

  async function checkMoreTweets(focalId) {
    while (moreCursor && hasThread && maxRequestCount > 0) {
      const next = await fetchTweetDetail(focalId, cookieMap, config, moreCursor);
      responses.push(next);
      const parsed = parseTweetsAndToken(next);
      moreCursor = parsed.moreCursor;
      bottomCursor = bottomCursor ?? parsed.bottomCursor;
      hasThread = inThread(parsed.entries);
      allEntries = allEntries.concat(parsed.entries);
      maxRequestCount -= 1;
    }

    if (bottomCursor) {
      const next = await fetchTweetDetail(focalId, cookieMap, config, bottomCursor);
      responses.push(next);
      const parsed = parseTweetsAndToken(next);
      allEntries = allEntries.concat(parsed.entries);
      bottomCursor = undefined;
    }
  }

  await checkMoreTweets(tweetId);

  const allThreadEntries = allEntries.filter(
    (entry) => entry.tweet?.legacy?.id_str === tweetId || isSameThread(entry)
  );
  const lastEntity = allThreadEntries[allThreadEntries.length - 1];
  if (lastEntity?.tweet?.legacy?.id_str) {
    const lastRes = await fetchTweetDetail(lastEntity.tweet.legacy.id_str, cookieMap, config);
    responses.push(lastRes);
    const parsed = parseTweetsAndToken(lastRes);
    hasThread = inThread(parsed.entries);
    allEntries = allEntries.concat(parsed.entries);
    moreCursor = parsed.moreCursor;
    bottomCursor = parsed.bottomCursor;
    maxRequestCount -= 1;
    await checkMoreTweets(lastEntity.tweet.legacy.id_str);
  }

  const distinctEntries = [];
  const entryMap = new Map();
  for (const entry of allEntries) {
    const id = entry.tweet?.legacy?.id_str ?? entry.tweet?.rest_id;
    if (id && !entryMap.has(id)) {
      entryMap.set(id, entry);
      distinctEntries.push(entry);
    }
  }

  const rootTweet = entryMap.get(tweetId)?.tweet ?? root.tweet;
  const conversationId = rootTweet?.legacy?.conversation_id_str;
  const inConversation = distinctEntries.filter((entry) => {
    const legacy = entry.tweet?.legacy;
    return legacy?.conversation_id_str === conversationId && legacy?.user_id_str === rootEntry.user_id_str;
  });
  inConversation.sort(
    (left, right) => toTimestamp(left.tweet?.legacy?.created_at) - toTimestamp(right.tweet?.legacy?.created_at)
  );

  return {
    requestedId: tweetId,
    rootId: rootTweet?.legacy?.id_str ?? tweetId,
    tweets: inConversation.map((entry) => entry.tweet),
    totalTweets: inConversation.length,
    user: root.user,
    responses,
  };
}

module.exports = {
  fetchTweetThread,
};
