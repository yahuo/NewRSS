const ECONOMIST_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.103 Mobile Safari/537.36 Liskov';

const matchesDomain = (hostname, domain) =>
  hostname === domain || hostname.endsWith(`.${domain}`);

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
  getArticleStrategy,
};
