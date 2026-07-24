const ECONOMIST_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.103 Mobile Safari/537.36 Liskov';
const NYTIMES_USER_AGENT = 'Mozilla/5.0 (compatible; Google-InspectionTool/1.0)';
const HYPEBEAST_RSS_FOOTER_PATTERN = /\bread more at hypebeast\s*$/i;

const matchesDomain = (hostname, domain) =>
  hostname === domain || hostname.endsWith(`.${domain}`);

const isNewYorkTimesLiveUrl = (url) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return false;
  }

  return matchesDomain(parsedUrl.hostname.toLowerCase(), 'nytimes.com') && parsedUrl.pathname.startsWith('/live/');
};

const mergeNewYorkerBody = (document) => {
  const containers = Array.from(document.querySelectorAll('.body__inner-container'));
  if (containers.length < 2) {
    return;
  }

  const primary = containers[0];
  for (const container of containers.slice(1)) {
    while (container.firstChild) {
      primary.appendChild(container.firstChild);
    }
    container.remove();
  }
};

const exposeForeignPolicyBody = (document) => {
  const preview = document.querySelector('div.content-ungated');
  if (!preview) {
    return;
  }

  preview.remove();
  document.querySelector('div.content-gated')?.classList.remove('content-gated');
};

const removeNewYorkTimesAds = (document) => {
  const ads = document.querySelectorAll(
    'div#top-wrapper, div#bottom-wrapper, div#dock-container, div[data-testid^="Dropzone-"]'
  );
  ads.forEach((element) => element.remove());

  document.querySelectorAll('div[class]').forEach((element) => {
    const isAdContainer = Array.from(element.classList).some(
      (className) =>
        className === 'ad-wrapper' || className.endsWith('-ad-wrapper') || className.startsWith('adunit_')
    );
    if (isAdContainer) {
      element.remove();
    }
  });

  document.querySelectorAll('div[data-testid="StandardAd"]').forEach((element) => {
    const container = element.parentElement;
    if (container?.matches('div[class^="css-"]')) {
      container.remove();
    } else {
      element.remove();
    }
  });
};

const ARTICLE_STRATEGIES = [
  {
    name: 'economist',
    domain: 'economist.com',
    preferPage: true,
    userAgent: ECONOMIST_USER_AGENT,
  },
  {
    name: 'new-yorker',
    domain: 'newyorker.com',
    preferPage: true,
    prepareDocument: mergeNewYorkerBody,
  },
  {
    name: 'foreign-policy',
    domain: 'foreignpolicy.com',
    preferPage: true,
    prepareDocument: exposeForeignPolicyBody,
  },
  {
    name: 'new-york-times',
    domain: 'nytimes.com',
    preferPage: true,
    userAgent: NYTIMES_USER_AGENT,
    prepareDocument: removeNewYorkTimesAds,
  },
  {
    name: 'hypebeast',
    domain: 'hypebeast.com',
    acceptTruncatedEmbeddedContent: (text) => HYPEBEAST_RSS_FOOTER_PATTERN.test(text),
  },
];

const getArticleStrategy = (url) => {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }

  return ARTICLE_STRATEGIES.find((strategy) => matchesDomain(hostname, strategy.domain)) || null;
};

module.exports = {
  ECONOMIST_USER_AGENT,
  NYTIMES_USER_AGENT,
  getArticleStrategy,
  isNewYorkTimesLiveUrl,
};
