const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BEARER_TOKEN =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const FALLBACK_QUERY_ID = 'id8pHQbQi7eZ6P9mA1th1Q';
const FALLBACK_FEATURE_SWITCHES = [
  'profile_label_improvements_pcf_label_in_post_enabled',
  'responsive_web_profile_redirect_enabled',
  'rweb_tipjar_consumption_enabled',
  'verified_phone_label_enabled',
  'responsive_web_graphql_skip_user_profile_image_extensions_enabled',
  'responsive_web_graphql_timeline_navigation_enabled',
];
const FALLBACK_FIELD_TOGGLES = ['withPayments', 'withAuxiliaryUserLabels'];

const FALLBACK_TWEET_QUERY_ID = 'HJ9lpOL-ZlOk5CkCw0JW6Q';
const FALLBACK_TWEET_FEATURE_SWITCHES = [
  'creator_subscriptions_tweet_preview_api_enabled',
  'premium_content_api_read_enabled',
  'communities_web_enable_tweet_community_results_fetch',
  'c9s_tweet_anatomy_moderator_badge_enabled',
  'responsive_web_grok_analyze_button_fetch_trends_enabled',
  'responsive_web_grok_analyze_post_followups_enabled',
  'responsive_web_jetfuel_frame',
  'responsive_web_grok_share_attachment_enabled',
  'responsive_web_grok_annotations_enabled',
  'articles_preview_enabled',
  'responsive_web_edit_tweet_api_enabled',
  'graphql_is_translatable_rweb_tweet_is_translatable_enabled',
  'view_counts_everywhere_api_enabled',
  'longform_notetweets_consumption_enabled',
  'responsive_web_twitter_article_tweet_consumption_enabled',
  'tweet_awards_web_tipping_enabled',
  'responsive_web_grok_show_grok_translated_post',
  'responsive_web_grok_analysis_button_from_backend',
  'post_ctas_fetch_enabled',
  'creator_subscriptions_quote_tweet_preview_enabled',
  'freedom_of_speech_not_reach_fetch_enabled',
  'standardized_nudges_misinfo',
  'tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled',
  'longform_notetweets_rich_text_read_enabled',
  'longform_notetweets_inline_media_enabled',
  'profile_label_improvements_pcf_label_in_post_enabled',
  'responsive_web_profile_redirect_enabled',
  'rweb_tipjar_consumption_enabled',
  'verified_phone_label_enabled',
  'responsive_web_grok_image_annotation_enabled',
  'responsive_web_grok_imagine_annotation_enabled',
  'responsive_web_grok_community_note_auto_translation_is_enabled',
  'responsive_web_graphql_skip_user_profile_image_extensions_enabled',
  'responsive_web_graphql_timeline_navigation_enabled',
  'responsive_web_enhance_cards_enabled',
];
const FALLBACK_TWEET_FIELD_TOGGLES = [
  'withArticleRichContentState',
  'withArticlePlainText',
  'withGrokAnalyze',
  'withDisallowedReplyControls',
  'withPayments',
  'withAuxiliaryUserLabels',
];

const FALLBACK_TWEET_DETAIL_QUERY_ID = '_8aYOgEDz35BrBcBal1-_w';
const FALLBACK_TWEET_DETAIL_FEATURE_SWITCHES = [
  'rweb_video_screen_enabled',
  'profile_label_improvements_pcf_label_in_post_enabled',
  'rweb_tipjar_consumption_enabled',
  'verified_phone_label_enabled',
  'creator_subscriptions_tweet_preview_api_enabled',
  'responsive_web_graphql_timeline_navigation_enabled',
  'responsive_web_graphql_skip_user_profile_image_extensions_enabled',
  'premium_content_api_read_enabled',
  'communities_web_enable_tweet_community_results_fetch',
  'c9s_tweet_anatomy_moderator_badge_enabled',
  'responsive_web_grok_analyze_button_fetch_trends_enabled',
  'responsive_web_grok_analyze_post_followups_enabled',
  'responsive_web_jetfuel_frame',
  'responsive_web_grok_share_attachment_enabled',
  'articles_preview_enabled',
  'responsive_web_edit_tweet_api_enabled',
  'graphql_is_translatable_rweb_tweet_is_translatable_enabled',
  'view_counts_everywhere_api_enabled',
  'longform_notetweets_consumption_enabled',
  'responsive_web_twitter_article_tweet_consumption_enabled',
  'tweet_awards_web_tipping_enabled',
  'responsive_web_grok_show_grok_translated_post',
  'responsive_web_grok_analysis_button_from_backend',
  'creator_subscriptions_quote_tweet_preview_enabled',
  'freedom_of_speech_not_reach_fetch_enabled',
  'standardized_nudges_misinfo',
  'tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled',
  'longform_notetweets_rich_text_read_enabled',
  'longform_notetweets_inline_media_enabled',
  'responsive_web_grok_image_annotation_enabled',
  'responsive_web_enhance_cards_enabled',
];
const FALLBACK_TWEET_DETAIL_FEATURE_DEFAULTS = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: false,
  responsive_web_grok_share_attachment_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: true,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};
const FALLBACK_TWEET_DETAIL_FIELD_TOGGLES = [
  'withArticleRichContentState',
  'withArticlePlainText',
  'withGrokAnalyze',
  'withDisallowedReplyControls',
];

let cachedHomeHtml = null;

function buildCookieHeader(cookieMap) {
  const entries = Object.entries(cookieMap).filter(([, value]) => value);
  if (!entries.length) {
    return undefined;
  }

  return entries.map(([key, value]) => `${key}=${value}`).join('; ');
}

function hasRequiredXCookies(cookieMap) {
  return Boolean(cookieMap.auth_token && cookieMap.ct0);
}

function readCookieFile(filePath) {
  if (!filePath) {
    return {};
  }

  const resolvedPath = path.resolve(String(filePath));
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`X cookie file not found: ${resolvedPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    throw new Error(`failed to parse X cookie file: ${error.message}`);
  }

  const candidate =
    parsed && typeof parsed === 'object' && parsed.cookieMap && typeof parsed.cookieMap === 'object'
      ? parsed.cookieMap
      : parsed;

  if (!candidate || typeof candidate !== 'object') {
    throw new Error(`X cookie file has unsupported shape: ${resolvedPath}`);
  }

  return pickKnownCookies(candidate);
}

function pickKnownCookies(candidate) {
  const cookieMap = {};
  for (const name of ['auth_token', 'ct0', 'gt', 'twid']) {
    const value = candidate[name];
    if (typeof value === 'string' && value.trim()) {
      cookieMap[name] = value.trim();
    }
  }
  return cookieMap;
}

function loadXCookies(config) {
  const fileCookies = readCookieFile(config.xCookieFile);
  const inlineCookies = pickKnownCookies({
    auth_token: config.xAuthToken,
    ct0: config.xCt0,
    gt: config.xGuestToken,
    twid: config.xTwid,
  });
  const cookieMap = {
    ...fileCookies,
    ...inlineCookies,
  };

  if (!hasRequiredXCookies(cookieMap)) {
    throw new Error('X extraction requires X_AUTH_TOKEN + X_CT0 or X_COOKIE_FILE');
  }

  return cookieMap;
}

async function fetchText(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}: ${text.slice(0, 200)}`);
  }
  return text;
}

async function fetchHomeHtml(userAgent) {
  if (cachedHomeHtml?.userAgent === userAgent) {
    return cachedHomeHtml.html;
  }

  const html = await fetchText('https://x.com', {
    headers: {
      'user-agent': userAgent,
    },
  });
  cachedHomeHtml = { userAgent, html };
  return html;
}

function parseStringList(raw) {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^"|"$/g, ''));
}

function resolveFeatureValue(html, key) {
  const keyPattern = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const unescaped = new RegExp(`"${keyPattern}"\\s*:\\s*\\{"value"\\s*:\\s*(true|false)`);
  const escaped = new RegExp(`\\\\"${keyPattern}\\\\"\\s*:\\s*\\\\{\\\\"value\\\\"\\s*:\\s*(true|false)`);
  const match = html.match(unescaped) || html.match(escaped);
  if (!match) {
    return undefined;
  }

  return match[1] === 'true';
}

function buildFeatureMap(html, keys, defaults) {
  const features = {};
  for (const key of keys) {
    const value = resolveFeatureValue(html, key);
    if (value !== undefined) {
      features[key] = value;
    } else if (defaults && Object.prototype.hasOwnProperty.call(defaults, key)) {
      features[key] = defaults[key] ?? true;
    } else {
      features[key] = true;
    }
  }

  if (!Object.prototype.hasOwnProperty.call(features, 'responsive_web_graphql_exclude_directive_enabled')) {
    features.responsive_web_graphql_exclude_directive_enabled = true;
  }

  return features;
}

function buildFieldToggleMap(keys) {
  const toggles = {};
  for (const key of keys) {
    toggles[key] = true;
  }
  return toggles;
}

function buildTweetFieldToggleMap(keys) {
  const toggles = {};
  for (const key of keys) {
    toggles[key] = key === 'withGrokAnalyze' || key === 'withDisallowedReplyControls' ? false : true;
  }
  return toggles;
}

function buildTweetDetailFieldToggleMap(keys) {
  const toggles = buildFieldToggleMap(keys);
  if (Object.prototype.hasOwnProperty.call(toggles, 'withArticlePlainText')) {
    toggles.withArticlePlainText = false;
  }
  if (Object.prototype.hasOwnProperty.call(toggles, 'withGrokAnalyze')) {
    toggles.withGrokAnalyze = false;
  }
  if (Object.prototype.hasOwnProperty.call(toggles, 'withDisallowedReplyControls')) {
    toggles.withDisallowedReplyControls = false;
  }
  return toggles;
}

function buildRequestHeaders(cookieMap, config) {
  const userAgent = config.xUserAgent || DEFAULT_USER_AGENT;
  const bearerToken = config.xBearerToken || DEFAULT_BEARER_TOKEN;
  const headers = {
    authorization: bearerToken,
    'user-agent': userAgent,
    accept: 'application/json',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'accept-language': 'en',
  };

  if (cookieMap.auth_token) {
    headers['x-twitter-auth-type'] = 'OAuth2Session';
  }

  const cookieHeader = buildCookieHeader(cookieMap);
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  }
  if (cookieMap.ct0) {
    headers['x-csrf-token'] = cookieMap.ct0;
  }
  if (config.xClientTransactionId) {
    headers['x-client-transaction-id'] = config.xClientTransactionId;
  }

  return headers;
}

function resolveArticleQueryInfo(userAgent) {
  return resolveGraphqlQueryInfo({
    userAgent,
    bundlePattern: /"bundle\\.TwitterArticles":"([a-z0-9]+)"/,
    chunkUrl: (hash) => `https://abs.twimg.com/responsive-web/client-web/bundle.TwitterArticles.${hash}a.js`,
    operationName: 'ArticleEntityResultByRestId',
    fallbackQueryId: FALLBACK_QUERY_ID,
    fallbackFeatureSwitches: FALLBACK_FEATURE_SWITCHES,
    fallbackFieldToggles: FALLBACK_FIELD_TOGGLES,
  });
}

function resolveTweetQueryInfo(userAgent) {
  return resolveGraphqlQueryInfo({
    userAgent,
    bundlePattern: /main\\.([a-z0-9]+)\\.js/,
    chunkUrl: (hash) => `https://abs.twimg.com/responsive-web/client-web/main.${hash}.js`,
    operationName: 'TweetResultByRestId',
    fallbackQueryId: FALLBACK_TWEET_QUERY_ID,
    fallbackFeatureSwitches: FALLBACK_TWEET_FEATURE_SWITCHES,
    fallbackFieldToggles: FALLBACK_TWEET_FIELD_TOGGLES,
  });
}

function resolveTweetDetailQueryInfo(userAgent) {
  return resolveGraphqlQueryInfo({
    userAgent,
    bundlePattern: /api:"([a-zA-Z0-9_-]+)"/,
    chunkUrl: (hash) => `https://abs.twimg.com/responsive-web/client-web/api.${hash}a.js`,
    operationName: 'TweetDetail',
    fallbackQueryId: FALLBACK_TWEET_DETAIL_QUERY_ID,
    fallbackFeatureSwitches: FALLBACK_TWEET_DETAIL_FEATURE_SWITCHES,
    fallbackFieldToggles: FALLBACK_TWEET_DETAIL_FIELD_TOGGLES,
  });
}

async function resolveGraphqlQueryInfo({
  userAgent,
  bundlePattern,
  chunkUrl,
  operationName,
  fallbackQueryId,
  fallbackFeatureSwitches,
  fallbackFieldToggles,
}) {
  const html = await fetchHomeHtml(userAgent);
  const bundleMatch = html.match(bundlePattern);
  if (!bundleMatch) {
    return {
      queryId: fallbackQueryId,
      featureSwitches: fallbackFeatureSwitches,
      fieldToggles: fallbackFieldToggles,
      html,
    };
  }

  const chunk = await fetchText(chunkUrl(bundleMatch[1]), {
    headers: {
      'user-agent': userAgent,
    },
  });
  const queryIdMatch = chunk.match(new RegExp(`queryId:\\"([^\\"]+)\\",operationName:\\"${operationName}\\"`));
  const featureMatch = chunk.match(
    new RegExp(`operationName:\\"${operationName}\\"[\\s\\S]*?featureSwitches:\\[(.*?)\\]`)
  );
  const fieldToggleMatch = chunk.match(
    new RegExp(`operationName:\\"${operationName}\\"[\\s\\S]*?fieldToggles:\\[(.*?)\\]`)
  );

  const featureSwitches = parseStringList(featureMatch?.[1]);
  const fieldToggles = parseStringList(fieldToggleMatch?.[1]);

  return {
    queryId: queryIdMatch?.[1] ?? fallbackQueryId,
    featureSwitches: featureSwitches.length ? featureSwitches : fallbackFeatureSwitches,
    fieldToggles: fieldToggles.length ? fieldToggles : fallbackFieldToggles,
    html,
  };
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`X API error (${response.status}): ${text.slice(0, 400)}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse response JSON: ${error.message}`);
  }
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

function extractArticleFromTweet(payload) {
  const root = payload?.data ?? payload;
  const result = root?.tweetResult?.result ?? root?.tweet_result?.result ?? root?.tweet_result;
  const tweet = unwrapTweetResult(result);
  const legacy = tweet?.legacy ?? {};
  const article = legacy?.article ?? tweet?.article;
  return article?.article_results?.result ?? legacy?.article_results?.result ?? tweet?.article_results?.result ?? null;
}

function extractTweetFromPayload(payload) {
  const root = payload?.data ?? payload;
  const result = root?.tweetResult?.result ?? root?.tweet_result?.result ?? root?.tweet_result;
  return unwrapTweetResult(result);
}

function extractArticleFromEntity(payload) {
  const root = payload?.data ?? payload;
  return root?.article_result_by_rest_id?.result ?? root?.article_result_by_rest_id ?? root?.article_entity_result?.result ?? null;
}

async function fetchTweetResult(tweetId, cookieMap, config) {
  const userAgent = config.xUserAgent || DEFAULT_USER_AGENT;
  const queryInfo = await resolveTweetQueryInfo(userAgent);
  const features = buildFeatureMap(queryInfo.html, queryInfo.featureSwitches);
  const fieldToggles = buildTweetFieldToggleMap(queryInfo.fieldToggles);
  const url = new URL(`https://x.com/i/api/graphql/${queryInfo.queryId}/TweetResultByRestId`);
  url.searchParams.set(
    'variables',
    JSON.stringify({
      tweetId,
      withCommunity: false,
      includePromotedContent: false,
      withVoice: true,
    })
  );
  if (Object.keys(features).length) {
    url.searchParams.set('features', JSON.stringify(features));
  }
  if (Object.keys(fieldToggles).length) {
    url.searchParams.set('fieldToggles', JSON.stringify(fieldToggles));
  }

  return fetchJson(url.toString(), buildRequestHeaders(cookieMap, config));
}

async function fetchArticleEntityById(articleEntityId, cookieMap, config) {
  const userAgent = config.xUserAgent || DEFAULT_USER_AGENT;
  const queryInfo = await resolveArticleQueryInfo(userAgent);
  const features = buildFeatureMap(queryInfo.html, queryInfo.featureSwitches);
  const fieldToggles = buildFieldToggleMap(queryInfo.fieldToggles);
  const url = new URL(`https://x.com/i/api/graphql/${queryInfo.queryId}/ArticleEntityResultByRestId`);
  url.searchParams.set('variables', JSON.stringify({ articleEntityId }));
  if (Object.keys(features).length) {
    url.searchParams.set('features', JSON.stringify(features));
  }
  if (Object.keys(fieldToggles).length) {
    url.searchParams.set('fieldToggles', JSON.stringify(fieldToggles));
  }

  return fetchJson(url.toString(), buildRequestHeaders(cookieMap, config));
}

async function fetchTweetDetail(tweetId, cookieMap, config, cursor) {
  const userAgent = config.xUserAgent || DEFAULT_USER_AGENT;
  const queryInfo = await resolveTweetDetailQueryInfo(userAgent);
  const features = buildFeatureMap(
    queryInfo.html,
    queryInfo.featureSwitches,
    FALLBACK_TWEET_DETAIL_FEATURE_DEFAULTS
  );
  const fieldToggles = buildTweetDetailFieldToggleMap(queryInfo.fieldToggles);
  const url = new URL(`https://x.com/i/api/graphql/${queryInfo.queryId}/TweetDetail`);
  url.searchParams.set(
    'variables',
    JSON.stringify({
      focalTweetId: tweetId,
      cursor,
      referrer: cursor ? 'tweet' : undefined,
      with_rux_injections: false,
      includePromotedContent: true,
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: true,
      withBirdwatchNotes: true,
      withVoice: true,
      withV2Timeline: true,
      withDownvotePerspective: false,
      withReactionsMetadata: false,
      withReactionsPerspective: false,
      withSuperFollowsTweetFields: false,
      withSuperFollowsUserFields: false,
    })
  );
  if (Object.keys(features).length) {
    url.searchParams.set('features', JSON.stringify(features));
  }
  if (Object.keys(fieldToggles).length) {
    url.searchParams.set('fieldToggles', JSON.stringify(fieldToggles));
  }

  return fetchJson(url.toString(), buildRequestHeaders(cookieMap, config));
}

async function fetchXTweet(tweetId, cookieMap, config) {
  const payload = await fetchTweetResult(tweetId, cookieMap, config);
  return extractTweetFromPayload(payload) ?? payload;
}

async function fetchXArticle(articleId, cookieMap, config) {
  const tweetPayload = await fetchTweetResult(articleId, cookieMap, config);
  const articleFromTweet = extractArticleFromTweet(tweetPayload);
  if (articleFromTweet && typeof articleFromTweet === 'object' && Object.keys(articleFromTweet).length) {
    return articleFromTweet;
  }

  const articlePayload = await fetchArticleEntityById(articleId, cookieMap, config);
  return extractArticleFromEntity(articlePayload) ?? articlePayload;
}

module.exports = {
  DEFAULT_BEARER_TOKEN,
  DEFAULT_USER_AGENT,
  fetchXArticle,
  fetchXTweet,
  fetchTweetDetail,
  hasRequiredXCookies,
  loadXCookies,
};
