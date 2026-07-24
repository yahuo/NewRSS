const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchTweetThread, parseTweetsAndToken } = require('../src/x-thread');

function tweetResult(id, index = Number(id) - 100) {
  return {
    __typename: 'Tweet',
    rest_id: id,
    legacy: {
      id_str: id,
      conversation_id_str: '100',
      user_id_str: 'user-1',
      in_reply_to_user_id_str: id === '100' ? undefined : 'user-1',
      in_reply_to_status_id_str: id === '100' ? undefined : '100',
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toUTCString(),
      full_text: `tweet ${id}`,
    },
    core: {
      user_results: {
        result: {
          legacy: {
            id_str: 'user-1',
            name: 'Alice',
            screen_name: 'alice',
          },
        },
      },
    },
  };
}

function timelineEntry(id, index) {
  return {
    entryId: `tweet-${id}`,
    content: {
      entryType: 'TimelineTimelineItem',
      itemContent: {
        itemType: 'TimelineTweet',
        tweet_results: { result: tweetResult(id, index) },
      },
    },
  };
}

function moduleItem(id, index) {
  return {
    entryId: `conversationthread-${id}`,
    item: {
      itemContent: {
        itemType: 'TimelineTweet',
        tweet_results: { result: tweetResult(id, index) },
      },
    },
  };
}

function cursorEntry(cursorType, value) {
  return {
    entryId: `cursor-${cursorType}-${value}`,
    content: {
      entryType: 'TimelineTimelineCursor',
      cursorType,
      value,
    },
  };
}

function threadResponse(instructions) {
  return {
    rawOnlySentinel: 'must-not-be-returned',
    data: {
      threaded_conversation_with_injections_v2: { instructions },
    },
  };
}

function entriesResponse(entries) {
  return threadResponse([{ type: 'TimelineAddEntries', entries }]);
}

test('parseTweetsAndToken merges every timeline instruction', () => {
  const parsed = parseTweetsAndToken(threadResponse([
    {
      type: 'TimelineAddEntries',
      entries: [timelineEntry('100'), cursorEntry('Top', 'top-A')],
    },
    {
      type: 'TimelineAddEntries',
      entries: [timelineEntry('101'), cursorEntry('Bottom', 'bottom-A')],
    },
    {
      type: 'TimelineAddToModule',
      moduleItems: [moduleItem('102')],
    },
  ]));

  assert.deepEqual(parsed.entries.map((entry) => entry.tweet.rest_id), ['100', '101', '102']);
  assert.deepEqual(parsed.topCursors, ['top-A']);
  assert.deepEqual(parsed.bottomCursors, ['bottom-A']);
});

test('fetchTweetThread stops repeated cursors and does not retain raw responses', async () => {
  const calls = [];
  const fetchTweetDetailFn = async (focalId, _cookieMap, _config, cursor) => {
    calls.push({ focalId, cursor });
    if (calls.length === 1) {
      return entriesResponse([timelineEntry('100'), cursorEntry('Bottom', 'same')]);
    }
    if (cursor === 'same') {
      return entriesResponse([timelineEntry('101'), cursorEntry('Bottom', 'same')]);
    }
    return entriesResponse([timelineEntry('101')]);
  };

  const result = await fetchTweetThread('100', {}, {}, { fetchTweetDetailFn });

  assert.equal(calls.filter((call) => call.cursor === 'same').length, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(result.tweets.map((tweet) => tweet.rest_id), ['100', '101']);
  assert.equal(Object.hasOwn(result, 'responses'), false);
  assert.equal(JSON.stringify(result).includes('rawOnlySentinel'), false);
});

test('fetchTweetThread caps total requests even when every page has a new cursor', async () => {
  let requestCount = 0;
  const fetchTweetDetailFn = async (_focalId, _cookieMap, _config, cursor) => {
    requestCount += 1;
    const cursorNumber = cursor ? Number(cursor.slice(1)) : 0;
    return entriesResponse([
      timelineEntry('100'),
      cursorEntry('Bottom', `c${cursorNumber + 1}`),
    ]);
  };

  const result = await fetchTweetThread('100', {}, {}, { fetchTweetDetailFn });

  assert.equal(requestCount, 24);
  assert.equal(result.totalTweets, 1);
});

test('fetchTweetThread caps unique tweets retained from a single page', async () => {
  const entries = Array.from({ length: 300 }, (_, index) => timelineEntry(String(100 + index), index));
  const result = await fetchTweetThread('100', {}, {}, {
    fetchTweetDetailFn: async () => entriesResponse(entries),
  });

  assert.equal(result.totalTweets, 250);
  assert.equal(result.tweets[0].rest_id, '100');
  assert.equal(Object.hasOwn(result, 'responses'), false);
});
