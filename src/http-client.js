const { ProxyAgent, Socks5ProxyAgent } = require('undici');

let cachedProxyUrl = null;
let cachedDispatcher = null;

const buildDispatcher = (proxyUrl) => {
  if (!proxyUrl) {
    return null;
  }

  if (cachedProxyUrl === proxyUrl && cachedDispatcher) {
    return cachedDispatcher;
  }

  cachedProxyUrl = proxyUrl;
  cachedDispatcher = proxyUrl.startsWith('socks5://') ? new Socks5ProxyAgent(proxyUrl) : new ProxyAgent(proxyUrl);
  return cachedDispatcher;
};

const withProxy = (proxyUrl, init = {}) => {
  const dispatcher = buildDispatcher(proxyUrl);
  if (!dispatcher) {
    return init;
  }

  return {
    ...init,
    dispatcher,
  };
};

module.exports = {
  withProxy,
};
