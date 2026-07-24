const { fetchTweetDetail } = require('./x-client');

const MAX_THREAD_REQUESTS = 24;
const MAX_THREAD_TWEETS = 250;

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
  const moreCursors = [];
  const topCursors = [];
  const bottomCursors = [];
  const addCursor = (cursors, value) => {
    if (typeof value === 'string' && value && !cursors.includes(value)) {
      cursors.push(value);
    }
  };
  const collectCursor = (cursorType, itemType, value) => {
    if (itemType !== 'TimelineTimelineCursor') {
      return false;
    }
    if (cursorType === 'Top') {
      addCursor(topCursors, value);
      return true;
    }
    if (cursorType === 'Bottom') {
      addCursor(bottomCursors, value);
      return true;
    }
    if (['ShowMore', 'ShowMoreThreads'].includes(cursorType)) {
      addCursor(moreCursors, value);
      return true;
    }
    return false;
  };

  const parseItems = (items) => {
    for (const item of items ?? []) {
      const itemContent = item?.item?.itemContent ?? item?.itemContent;
      if (!itemContent) {
        continue;
      }

      if (collectCursor(itemContent.cursorType, itemContent.itemType, itemContent.value)) {
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
    collectCursor(cursorType, entryType, value);
    collectCursor(itemContent?.cursorType, itemContent?.itemType, itemContent?.value);

    const entry = extractTweetEntry(itemContent);
    if (entry) {
      entries.push(entry);
    }

    if (items) {
      parseItems(items);
    }
  }

  return {
    entries,
    moreCursor: moreCursors[0],
    topCursor: topCursors[0],
    bottomCursor: bottomCursors[0],
    moreCursors,
    topCursors,
    bottomCursors,
  };
}

function parseTweetsAndToken(response) {
  const isTimelineInstruction = (instruction) =>
    instruction?.type === 'TimelineAddEntries' || instruction?.type === 'TimelineAddToModule';
  const v2Instructions = (
    response?.data?.threaded_conversation_with_injections_v2?.instructions ?? []
  ).filter(isTimelineInstruction);
  const legacyInstructions = (
    response?.data?.threaded_conversation_with_injections?.instructions ?? []
  ).filter(isTimelineInstruction);
  const instructions = v2Instructions.length ? v2Instructions : legacyInstructions;
  const entries = [];
  const moreCursors = [];
  const topCursors = [];
  const bottomCursors = [];
  const mergeCursors = (target, values) => {
    for (const value of values) {
      if (!target.includes(value)) {
        target.push(value);
      }
    }
  };

  for (const instruction of instructions) {
    const parsed = parseInstruction(instruction);
    entries.push(...parsed.entries);
    mergeCursors(moreCursors, parsed.moreCursors);
    mergeCursors(topCursors, parsed.topCursors);
    mergeCursors(bottomCursors, parsed.bottomCursors);
  }

  return {
    entries,
    moreCursor: moreCursors[0],
    topCursor: topCursors[0],
    bottomCursor: bottomCursors[0],
    moreCursors,
    topCursors,
    bottomCursors,
  };
}

function toTimestamp(value) {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function fetchTweetThread(tweetId, cookieMap, config, dependencies = {}) {
  const fetchDetail = dependencies.fetchTweetDetailFn ?? fetchTweetDetail;
  const initialResponse = await fetchDetail(tweetId, cookieMap, config);
  const initial = parseTweetsAndToken(initialResponse);
  if (!initial.entries.length) {
    const errorMessage = initialResponse?.errors?.[0]?.message;
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    return null;
  }

  const entryId = (entry) => entry.tweet?.legacy?.id_str ?? entry.tweet?.rest_id;
  const root = initial.entries.find((entry) => entryId(entry) === tweetId);
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
  const isConversationEntry = (entry) => {
    const tweet = entry.tweet?.legacy;
    return (
      tweet?.user_id_str === rootEntry.user_id_str &&
      tweet?.conversation_id_str === rootEntry.conversation_id_str
    );
  };
  const entryMap = new Map();
  const addEntries = (entries) => {
    for (const entry of entries) {
      if (entryMap.size >= MAX_THREAD_TWEETS) {
        return;
      }
      const id = entryId(entry);
      if (id && isConversationEntry(entry) && !entryMap.has(id)) {
        entryMap.set(id, entry);
      }
    }
  };
  addEntries([root, ...initial.entries]);

  const cursorQueue = [];
  const queuedCursors = new Set();
  const seenCursors = new Set();
  let queueIndex = 0;
  let requestCount = 1;

  const enqueueCursors = (parsed, focalId) => {
    for (const cursor of [
      ...parsed.topCursors,
      ...parsed.moreCursors,
      ...parsed.bottomCursors,
    ]) {
      if (!seenCursors.has(cursor) && !queuedCursors.has(cursor)) {
        queuedCursors.add(cursor);
        cursorQueue.push({ cursor, focalId });
      }
    }
  };

  const processCursorQueue = async () => {
    while (
      queueIndex < cursorQueue.length &&
      requestCount < MAX_THREAD_REQUESTS &&
      entryMap.size < MAX_THREAD_TWEETS
    ) {
      const { cursor, focalId } = cursorQueue[queueIndex];
      queueIndex += 1;
      queuedCursors.delete(cursor);
      if (seenCursors.has(cursor)) {
        continue;
      }
      seenCursors.add(cursor);

      const response = await fetchDetail(focalId, cookieMap, config, cursor);
      requestCount += 1;
      const parsed = parseTweetsAndToken(response);
      const pageHasThread = parsed.entries.some(isSameThread);
      addEntries(parsed.entries);
      if (pageHasThread) {
        enqueueCursors(parsed, focalId);
      }
    }
  };

  enqueueCursors(initial, tweetId);
  await processCursorQueue();

  if (requestCount < MAX_THREAD_REQUESTS && entryMap.size < MAX_THREAD_TWEETS) {
    const latestEntry = Array.from(entryMap.values())
      .filter((entry) => entryId(entry) === tweetId || isSameThread(entry))
      .reduce(
        (latest, entry) =>
          toTimestamp(entry.tweet?.legacy?.created_at) > toTimestamp(latest.tweet?.legacy?.created_at)
            ? entry
            : latest,
        root
      );
    const latestId = entryId(latestEntry);
    if (latestId && latestId !== tweetId) {
      const response = await fetchDetail(latestId, cookieMap, config);
      requestCount += 1;
      const parsed = parseTweetsAndToken(response);
      addEntries(parsed.entries);
      if (parsed.entries.some(isSameThread)) {
        enqueueCursors(parsed, latestId);
        await processCursorQueue();
      }
    }
  }

  const rootTweet = entryMap.get(tweetId)?.tweet ?? root.tweet;
  const inConversation = Array.from(entryMap.values());
  inConversation.sort(
    (left, right) => toTimestamp(left.tweet?.legacy?.created_at) - toTimestamp(right.tweet?.legacy?.created_at)
  );

  return {
    requestedId: tweetId,
    rootId: rootTweet?.legacy?.id_str ?? rootTweet?.rest_id ?? tweetId,
    tweets: inConversation.map((entry) => entry.tweet),
    totalTweets: inConversation.length,
    user: root.user,
  };
}

module.exports = {
  fetchTweetThread,
  parseTweetsAndToken,
};
