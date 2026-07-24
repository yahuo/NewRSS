const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractReferencedTweetIds,
  formatArticleMarkdown,
  formatThreadMarkdown,
  formatThreadTweetsMarkdown,
} = require('../src/x-format');

test('formats a rich X article without losing links, embeds, code, or media', () => {
  const article = {
    title: 'Rich article',
    cover_media: {
      media_info: { original_img_url: 'https://pbs.twimg.com/cover.jpg' },
    },
    media_entities: [
      {
        media_id: 'photo-1',
        media_info: { original_img_url: 'https://pbs.twimg.com/photo.jpg' },
      },
      {
        media_id: 'video-1',
        media_info: {
          preview_image: { original_img_url: 'https://pbs.twimg.com/poster.jpg' },
          variants: [
            { content_type: 'video/mp4', bit_rate: 128, url: 'https://video.twimg.com/low.mp4' },
            { content_type: 'video/mp4', bit_rate: 512, url: 'https://video.twimg.com/high.mp4' },
          ],
        },
      },
      {
        media_id: 'trailing-photo',
        media_info: { preview_image: { original_img_url: 'https://pbs.twimg.com/trailing.jpg' } },
      },
    ],
    content_state: {
      entityMap: {
        0: { key: '10', value: { type: 'LINK', data: { url: 'https://example.com/story' } } },
        1: {
          key: '20',
          value: {
            type: 'MEDIA',
            data: { caption: 'Photo [caption]', mediaItems: [{ mediaId: 'photo-1' }] },
          },
        },
        2: {
          key: '30',
          value: {
            type: 'MEDIA',
            data: { caption: 'Video clip', mediaItems: [{ media_id: 'video-1' }] },
          },
        },
        3: { key: '40', value: { type: 'TWEET', data: { tweetId: '42' } } },
        4: {
          key: '50',
          value: { type: 'MARKDOWN', data: { markdown: '**embedded**\r\nline' } },
        },
        5: {
          key: '60',
          value: {
            type: 'IMAGE',
            data: { caption: 'Fallback image', url: 'https://pbs.twimg.com/fallback.jpg' },
          },
        },
        6: {
          key: '70',
          value: {
            type: 'MEDIA',
            data: { caption: 'Fallback video', url: 'https://video.twimg.com/fallback.webm' },
          },
        },
      },
      blocks: [
        { type: 'header-one', text: 'Heading one' },
        {
          type: 'unstyled',
          text: 'Read story and photo',
          entityRanges: [
            { key: 10, offset: 5, length: 5 },
            { key: 20, offset: 15, length: 5 },
          ],
        },
        {
          type: 'unordered-list-item',
          text: 'First item',
          entityRanges: [{ key: 20, offset: 0, length: 0 }],
        },
        { type: 'ordered-list-item', text: 'Ordered one' },
        { type: 'ordered-list-item', text: 'Ordered two' },
        { type: 'blockquote', text: 'Line one\nLine two' },
        { type: 'code-block', text: 'const one = 1;' },
        { type: 'code-block', text: 'const two = 2;' },
        { type: 'atomic', text: '', entityRanges: [{ key: 40, offset: 0, length: 1 }] },
        { type: 'atomic', text: '', entityRanges: [{ key: 50, offset: 0, length: 1 }] },
        { type: 'atomic', text: '', entityRanges: [{ key: 30, offset: 0, length: 1 }] },
        { type: 'atomic', text: '', entityRanges: [{ key: 10, offset: 0, length: 1 }] },
        { type: 'header-two', text: 'Heading two' },
        { type: 'header-three', text: 'Heading three' },
        { type: 'header-four', text: 'Heading four' },
        { type: 'header-five', text: 'Heading five' },
        { type: 'header-six', text: 'Heading six' },
        {
          type: 'unstyled',
          text: 'XIMGPH_1',
          entityRanges: [{ key: 60, offset: 0, length: 9 }],
        },
        { type: 'atomic', text: '', entityRanges: [{ key: 70, offset: 0, length: 1 }] },
      ],
    },
  };

  const referencedTweets = new Map([
    ['42', {
      authorName: 'Quoted Author',
      authorUsername: 'quoted',
      text: 'A quoted tweet\nwith extra whitespace',
      url: 'https://x.com/quoted/status/42',
    }],
  ]);

  const result = formatArticleMarkdown(article, { referencedTweets });

  assert.equal(result.coverUrl, 'https://pbs.twimg.com/cover.jpg');
  assert.match(result.markdown, /^# Rich article/m);
  assert.match(result.markdown, /Read \[story\]\(https:\/\/example\.com\/story\)/);
  assert.match(result.markdown, /\[photo\]\(https:\/\/example\.com\/story\)/);
  assert.match(result.markdown, /- First item/);
  assert.match(result.markdown, /1\. Ordered one\n2\. Ordered two/);
  assert.match(result.markdown, /> Line one\n> Line two/);
  assert.match(result.markdown, /```\nconst one = 1;\nconst two = 2;\n```/);
  assert.match(result.markdown, /> 引用推文：Quoted Author \(@quoted\)/);
  assert.match(result.markdown, /> https:\/\/x\.com\/quoted\/status\/42/);
  assert.match(result.markdown, /\*\*embedded\*\*\nline/);
  assert.match(result.markdown, /!\[Video clip\]\(https:\/\/pbs\.twimg\.com\/poster\.jpg\)/);
  assert.match(result.markdown, /\[video\]\(https:\/\/video\.twimg\.com\/high\.mp4\)/);
  assert.match(result.markdown, /!\[Fallback image\]\(https:\/\/pbs\.twimg\.com\/fallback\.jpg\)/);
  assert.match(result.markdown, /\[video\]\(https:\/\/video\.twimg\.com\/fallback\.webm\)/);
  assert.match(result.markdown, /## Media/);
  assert.match(result.markdown, /!\[\]\(https:\/\/pbs\.twimg\.com\/trailing\.jpg\)/);
  assert.deepEqual(extractReferencedTweetIds(article), ['42']);
});

test('article formatting supports fallbacks, invalid input, and duplicate references', () => {
  assert.deepEqual(formatArticleMarkdown(null), {
    markdown: '```json\nnull\n```',
    coverUrl: null,
  });
  assert.equal(formatArticleMarkdown({ plain_text: ' Plain body ' }).markdown, 'Plain body');
  assert.equal(formatArticleMarkdown({ preview_text: ' Preview body ' }).markdown, 'Preview body');
  assert.deepEqual(extractReferencedTweetIds({}), []);
  assert.deepEqual(extractReferencedTweetIds({
    content_state: {
      entityMap: {
        0: { value: { type: 'TWEET', data: { tweetId: '7' } } },
        1: { value: { type: 'TWEET', data: { tweetId: '7' } } },
        2: { value: { type: 'TWEET', data: {} } },
      },
    },
  }), ['7']);
});

test('formats rich tweet threads with quote, photo, video, and author metadata', () => {
  const quoted = {
    rest_id: '200',
    legacy: { full_text: 'Quoted text' },
    core: {
      user_results: { result: { legacy: { name: 'Bob', screen_name: 'bob' } } },
    },
  };
  const tweet = {
    rest_id: '100',
    legacy: {
      id_str: '100',
      full_text: 'First line\nSecond line',
      extended_entities: {
        media: [
          {
            type: 'photo',
            media_url_https: 'https://pbs.twimg.com/thread-photo.jpg',
            ext_alt_text: 'Photo [alt]',
          },
          {
            type: 'video',
            media_url_https: 'https://pbs.twimg.com/thread-poster.jpg',
            ext_alt_text: ' Video   alt ',
            video_info: {
              variants: [
                { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/list.m3u8' },
                { content_type: 'video/mp4', bitrate: 64, url: 'https://video.twimg.com/thread-low.mp4' },
                { content_type: 'video/mp4', bitrate: 256, url: 'https://video.twimg.com/thread-high.mp4' },
              ],
            },
          },
        ],
      },
    },
    core: {
      user_results: { result: { legacy: { name: 'Alice', screen_name: 'alice' } } },
    },
    quoted_status_result: {
      result: { __typename: 'TweetWithVisibilityResults', tweet: quoted },
    },
  };

  const result = formatThreadMarkdown({
    tweets: [tweet, { rest_id: '101', legacy: {} }],
    rootId: '100',
    totalTweets: 2,
  }, { title: 'Saved thread' });

  assert.match(result, /^# Saved thread/m);
  assert.match(result, /Source: https:\/\/x\.com\/alice\/status\/100/);
  assert.match(result, /Tweets: 2/);
  assert.match(result, /## 1\nhttps:\/\/x\.com\/alice\/status\/100/);
  assert.match(result, /> Author: Bob \(@bob\)/);
  assert.match(result, /> URL: https:\/\/x\.com\/bob\/status\/200/);
  assert.ok(result.includes('![Photo \\[alt\\]](https://pbs.twimg.com/thread-photo.jpg)'));
  assert.match(result, /!\[Video alt\]\(https:\/\/pbs\.twimg\.com\/thread-poster\.jpg\)/);
  assert.match(result, /\[video\]\(https:\/\/video\.twimg\.com\/thread-high\.mp4\)/);
  assert.match(result, /## 2\nhttps:\/\/x\.com\/alice\/status\/101\n\n_No text or media\._/);
});

test('thread formatting supports custom headings, hidden URLs, and invalid input', () => {
  const tweetMarkdown = formatThreadTweetsMarkdown([
    { rest_id: '1', note_tweet: { note_tweet_results: { result: { text: 'Note text' } } } },
  ], {
    headingLevel: 9,
    includeIndexHeading: true,
    includeTweetUrls: false,
    startIndex: 3,
  });

  assert.equal(tweetMarkdown, '###### 3\n\nNote text');
  assert.equal(formatThreadTweetsMarkdown([]), '');
  assert.equal(formatThreadTweetsMarkdown(null), '');
  assert.equal(formatThreadMarkdown({ tweets: [] }, { includeHeader: false }), '');
  assert.equal(formatThreadMarkdown({ tweets: [] }), '# Thread');
  assert.equal(formatThreadMarkdown(null), '```json\nnull\n```');
});

test('formats sparse X payloads with stable public fallbacks', () => {
  assert.equal(
    formatArticleMarkdown({ title: 'Plain title', plain_text: 'Plain body' }).markdown,
    '# Plain title\n\nPlain body'
  );
  assert.equal(
    formatArticleMarkdown({ title: 'Preview title', preview_text: 'Preview body' }).markdown,
    '# Preview title\n\nPreview body'
  );

  const embeddedTweet = formatArticleMarkdown({
    media_entities: [{ media_id: 'missing-info' }],
    content_state: {
      entityMap: {
        0: { value: { type: 'TWEET', data: { tweetId: '99' } } },
      },
      blocks: [
        { type: 'atomic', text: '', entityRanges: [{ key: 0, offset: 0, length: 0 }] },
      ],
    },
  });
  assert.match(embeddedTweet.markdown, /> 引用推文\n> https:\/\/x\.com\/i\/web\/status\/99/);

  const sparseTweet = {
    rest_id: '300',
    legacy: {
      text: 'Sparse tweet',
      extended_entities: {
        media: [
          { type: 'photo' },
          {
            type: 'animated_gif',
            video_info: {
              variants: [{ content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/gif.m3u8' }],
            },
          },
          {
            type: 'video',
            video_info: { variants: [{ content_type: 'video/mp4' }] },
          },
        ],
      },
    },
    core: {
      user_results: { result: { legacy: { screen_name: 'solo' } } },
    },
    quoted_status_result: {
      result: {
        rest_id: '301',
        core: { user_results: { result: { legacy: { screen_name: 'quoted-only' } } } },
      },
    },
  };
  const sparseThread = formatThreadMarkdown({ tweets: [sparseTweet], requestedId: '300' });
  assert.match(sparseThread, /^# Thread by @solo/m);
  assert.match(sparseThread, /> Author: @quoted-only/);
  assert.match(sparseThread, /> \(no content\)/);
  assert.match(sparseThread, /\[animated_gif\]\(https:\/\/video\.twimg\.com\/gif\.m3u8\)/);
});

test('ignores incomplete X article entities while preserving surrounding content', () => {
  const article = {
    media_entities: [
      { media_info: { original_img_url: 'https://pbs.twimg.com/no-id.jpg' } },
      { media_id: 'empty-media', media_info: {} },
      {
        media_id: 'usable-media',
        media_info: { original_img_url: 'https://pbs.twimg.com/usable.jpg' },
      },
    ],
    content_state: {
      entityMap: {
        0: { key: '10', value: { type: 'TWEET', data: {} } },
        1: { key: '20', value: { type: 'MARKDOWN', data: { markdown: '   ' } } },
        2: {
          key: '30',
          value: { type: 'MEDIA', data: { mediaItems: [{ mediaId: 'usable-media' }] } },
        },
      },
      blocks: [
        {
          type: 'unstyled',
          text: 'Unlinked text',
          entityRanges: [{ key: 999, offset: 0, length: 8 }],
        },
        {
          type: 'atomic',
          text: '',
          entityRanges: [
            { key: 'not-a-number', offset: 0, length: 0 },
            { key: 10, offset: 0, length: 0 },
            { key: 20, offset: 0, length: 0 },
            { key: 30, offset: 0, length: 0 },
          ],
        },
        { type: 'code-block', text: 'code before text' },
        { type: 'unstyled', text: 'After code' },
        { type: 'code-block', text: 'code at end' },
      ],
    },
  };

  const result = formatArticleMarkdown(article);
  assert.match(result.markdown, /^Unlinked text/m);
  assert.match(result.markdown, /!\[\]\(https:\/\/pbs\.twimg\.com\/usable\.jpg\)/);
  assert.match(result.markdown, /```\ncode before text\n```\n\nAfter code/);
  assert.match(result.markdown, /```\ncode at end\n```/);
  assert.match(result.markdown, /## Media\n\n!\[\]\(https:\/\/pbs\.twimg\.com\/no-id\.jpg\)$/);

  assert.equal(formatArticleMarkdown({
    content_state: { blocks: [{ type: 'unstyled', text: 'No entity map' }] },
  }).markdown, 'No entity map');
});
