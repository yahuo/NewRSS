const dns = require('node:dns').promises;
const net = require('node:net');
const { Agent } = require('undici');
const { withProxy } = require('./http-client');

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCKED_METADATA_HOSTS = new Set(['metadata.google.internal']);
const SENSITIVE_REDIRECT_HEADERS = ['authorization', 'cookie', 'host', 'proxy-authorization'];

async function assertSafeOutboundUrl(rawUrl, options = {}) {
  let parsedUrl;
  try {
    parsedUrl = rawUrl instanceof URL ? new URL(rawUrl.toString()) : new URL(String(rawUrl || ''));
  } catch {
    throw outboundError('OUTBOUND_URL_INVALID', 'outbound URL must be valid');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw outboundError('OUTBOUND_URL_PROTOCOL', 'outbound URL must use HTTP or HTTPS');
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw outboundError('OUTBOUND_URL_CREDENTIALS', 'outbound URL must not contain credentials');
  }

  const hostname = normalizeHostname(parsedUrl.hostname);
  if (!hostname) {
    throw outboundError('OUTBOUND_URL_HOST', 'outbound URL must contain a hostname');
  }

  const allowedHosts = normalizeAllowedHosts(options.allowedHosts);
  if (allowedHosts.has(hostname)) {
    return parsedUrl;
  }
  if (BLOCKED_METADATA_HOSTS.has(hostname)) {
    throw blockedAddressError(hostname, hostname);
  }

  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    assertPublicIpAddress(hostname);
    return parsedUrl;
  }

  const lookup = options.lookup || dns.lookup;
  let records;
  try {
    records = await resolveHostRecords(hostname, lookup);
  } catch (error) {
    if (error?.code?.startsWith?.('OUTBOUND_')) {
      throw error;
    }
    throw outboundError('OUTBOUND_DNS_LOOKUP_FAILED', `unable to resolve outbound host: ${hostname}`, error);
  }

  for (const record of records) {
    assertPublicIpAddress(record.address, hostname);
  }

  return parsedUrl;
}

async function fetchText(rawUrl, options = {}) {
  const fetchImplementation = options.fetchImpl || options.fetch || globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('fetch implementation is required');
  }

  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
  const maxRedirects = nonNegativeInteger(options.maxRedirects, DEFAULT_MAX_REDIRECTS, 'maxRedirects');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const removeAbortListener = forwardAbort(options.signal, controller);
  const proxyUrl = options.upstreamProxyUrl || options.proxyUrl || '';
  // A proxy or caller-owned dispatcher controls socket DNS. Those modes still receive
  // URL/DNS preflight checks, but only the temporary direct Agent can revalidate the
  // exact address selected at connection time and close the DNS-rebinding window.
  const ownedDispatcher = !proxyUrl && !options.dispatcher
    ? new Agent({
        connect: {
          lookup: createSafeSocketLookup(options.lookup || dns.lookup, options.allowedHosts),
        },
      })
    : null;
  let requestHeaders = new Headers(options.headers || {});
  requestHeaders.delete('host');

  try {
    let currentUrl = rawUrl;
    for (let redirectCount = 0; ; redirectCount += 1) {
      const validatedUrl = await awaitWithAbort(
        assertSafeOutboundUrl(currentUrl, {
          allowedHosts: options.allowedHosts,
          lookup: options.lookup,
        }),
        controller.signal
      );
      const requestInit = {
        headers: requestHeaders,
        redirect: 'manual',
        signal: controller.signal,
      };
      const proxiedInit = options.dispatcher
        ? { ...requestInit, dispatcher: options.dispatcher }
        : ownedDispatcher
          ? { ...requestInit, dispatcher: ownedDispatcher }
          : withProxy(proxyUrl, requestInit);
      const response = await awaitWithAbort(fetchImplementation(validatedUrl, proxiedInit), controller.signal);

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers?.get?.('location');
        if (!location) {
          await cancelResponseBody(response);
          throw outboundError('OUTBOUND_REDIRECT_LOCATION', `redirect response ${response.status} has no location`);
        }
        if (redirectCount >= maxRedirects) {
          await cancelResponseBody(response);
          throw outboundError('OUTBOUND_REDIRECT_LIMIT', `outbound request exceeded ${maxRedirects} redirects`);
        }

        let nextUrl;
        try {
          nextUrl = new URL(location, validatedUrl);
        } catch (error) {
          await cancelResponseBody(response);
          throw outboundError('OUTBOUND_REDIRECT_LOCATION', 'redirect response has an invalid location', error);
        }
        if (nextUrl.origin !== validatedUrl.origin) {
          requestHeaders = stripSensitiveRedirectHeaders(requestHeaders);
        }
        await cancelResponseBody(response);
        currentUrl = nextUrl;
        continue;
      }

      if (!isSuccessfulResponse(response)) {
        await cancelResponseBody(response);
        throw outboundError('OUTBOUND_HTTP_STATUS', `outbound request failed with status ${response.status}`);
      }

      try {
        assertContentLength(response, maxBytes);
      } catch (error) {
        await cancelResponseBody(response);
        throw error;
      }
      return await awaitWithAbort(readResponseText(response, maxBytes), controller.signal);
    }
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted && error?.code !== 'OUTBOUND_RESPONSE_TOO_LARGE') {
      throw outboundError('OUTBOUND_TIMEOUT', `outbound request timed out after ${timeoutMs}ms`, error);
    }
    throw findOutboundCause(error) || error;
  } finally {
    clearTimeout(timer);
    removeAbortListener();
    await closeDispatcher(ownedDispatcher);
  }
}

async function resolveHostRecords(hostname, lookup, lookupOptions = {}) {
  const result = await lookup(hostname, {
    ...lookupOptions,
    all: true,
    verbatim: true,
  });
  const rawRecords = Array.isArray(result) ? result : [result];
  if (!rawRecords.length) {
    throw outboundError('OUTBOUND_DNS_LOOKUP_FAILED', `outbound host resolved no addresses: ${hostname}`);
  }

  return rawRecords.map((record) => {
    const address = typeof record === 'string' ? record : record?.address;
    const normalizedAddress = stripIpv6Zone(address);
    const family = net.isIP(normalizedAddress);
    if (!family) {
      throw outboundError('OUTBOUND_DNS_LOOKUP_FAILED', `outbound host resolved an invalid address: ${hostname}`);
    }
    return { address, family };
  });
}

function createSafeSocketLookup(lookup, allowedHosts) {
  const allowed = normalizeAllowedHosts(allowedHosts);
  return (hostname, lookupOptions, callback) => {
    resolveHostRecords(hostname, lookup, lookupOptions)
      .then((records) => {
        const normalizedHostname = normalizeHostname(hostname);
        if (!allowed.has(normalizedHostname)) {
          for (const record of records) {
            assertPublicIpAddress(record.address, normalizedHostname);
          }
        }

        if (lookupOptions?.all) {
          callback(null, records);
          return;
        }
        const requestedFamily = Number(lookupOptions?.family) || 0;
        const selected = records.find((record) => !requestedFamily || record.family === requestedFamily);
        if (!selected) {
          const error = new Error(`outbound host has no address for family ${requestedFamily}`);
          error.code = 'ENOTFOUND';
          callback(error);
          return;
        }
        callback(null, selected.address, selected.family);
      })
      .catch((error) => callback(error));
  };
}

function assertPublicIpAddress(address, hostname = '') {
  const normalizedAddress = stripIpv6Zone(address);
  const family = net.isIP(normalizedAddress);
  const blocked = family === 4
    ? isBlockedIpv4(parseIpv4(normalizedAddress))
    : family === 6
      ? isBlockedIpv6(parseIpv6(normalizedAddress))
      : true;

  if (blocked) {
    throw blockedAddressError(hostname || normalizedAddress, normalizedAddress);
  }
}

function isBlockedIpv4(value) {
  return IPV4_BLOCKS.some(({ base, prefix }) => inCidr(value, base, prefix, 32));
}

function isBlockedIpv6(value) {
  if (value === 0n || value === 1n) {
    return true;
  }

  if (inCidr(value, IPV6_MAPPED_BASE, 96, 128)) {
    return isBlockedIpv4(value & 0xffffffffn);
  }
  if (inCidr(value, IPV6_COMPATIBLE_BASE, 96, 128)) {
    return true;
  }
  if (inCidr(value, NAT64_WELL_KNOWN_BASE, 96, 128)) {
    return isBlockedIpv4(value & 0xffffffffn);
  }
  if (inCidr(value, NAT64_LOCAL_BASE, 48, 128)) {
    return true;
  }
  if (inCidr(value, SIX_TO_FOUR_BASE, 16, 128)) {
    const embeddedIpv4 = (value >> 80n) & 0xffffffffn;
    return isBlockedIpv4(embeddedIpv4);
  }
  if (IPV6_BLOCKS.some(({ base, prefix }) => inCidr(value, base, prefix, 128))) {
    return true;
  }

  return !inCidr(value, GLOBAL_UNICAST_BASE, 3, 128);
}

function assertContentLength(response, maxBytes) {
  const headerValue = response.headers?.get?.('content-length');
  if (headerValue == null || String(headerValue).trim() === '') {
    return;
  }

  const normalized = String(headerValue).trim();
  if (!/^\d+$/.test(normalized)) {
    throw outboundError('OUTBOUND_CONTENT_LENGTH', 'outbound response has an invalid content-length');
  }
  if (BigInt(normalized) > BigInt(maxBytes)) {
    throw outboundError('OUTBOUND_RESPONSE_TOO_LARGE', `outbound response exceeds ${maxBytes} bytes`);
  }
}

async function readResponseText(response, maxBytes) {
  if (!response.body) {
    return '';
  }
  if (typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw outboundError('OUTBOUND_RESPONSE_TOO_LARGE', `outbound response exceeds ${maxBytes} bytes`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      byteCount += value.byteLength;
      if (byteCount > maxBytes) {
        await reader.cancel();
        throw outboundError('OUTBOUND_RESPONSE_TOO_LARGE', `outbound response exceeds ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function stripSensitiveRedirectHeaders(headers) {
  const sanitized = new Headers(headers);
  for (const name of SENSITIVE_REDIRECT_HEADERS) {
    sanitized.delete(name);
  }
  return sanitized;
}

async function cancelResponseBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    // The response is already closed; there is nothing left to release.
  }
}

async function closeDispatcher(dispatcher) {
  if (!dispatcher) {
    return;
  }
  try {
    await dispatcher.close();
  } catch {
    // A failed request may already have destroyed the temporary dispatcher.
  }
}

function findOutboundCause(error) {
  let current = error;
  while (current) {
    if (current.code?.startsWith?.('OUTBOUND_')) {
      return current;
    }
    current = current.cause;
  }
  return null;
}

function isSuccessfulResponse(response) {
  return response.ok === true || (response.status >= 200 && response.status < 300);
}

function normalizeAllowedHosts(value) {
  if (value == null || value === '') {
    return new Set();
  }
  const entries = typeof value === 'string' ? [value] : Array.from(value);
  return new Set(entries.map(normalizeHostname).filter(Boolean));
}

function normalizeHostname(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function stripIpv6Zone(value) {
  return String(value || '').split('%')[0];
}

function parseIpv4(address) {
  return address.split('.').reduce((result, part) => (result << 8n) | BigInt(part), 0n);
}

function parseIpv6(address) {
  let normalized = stripIpv6Zone(address).toLowerCase();
  if (normalized.includes('.')) {
    const separator = normalized.lastIndexOf(':');
    const ipv4 = parseIpv4(normalized.slice(separator + 1));
    normalized = `${normalized.slice(0, separator)}:${(ipv4 >> 16n).toString(16)}:${(ipv4 & 0xffffn).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) {
    throw new Error(`invalid IPv6 address: ${address}`);
  }
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    throw new Error(`invalid IPv6 address: ${address}`);
  }
  const groups = halves.length === 2
    ? [...left, ...Array(missing).fill('0'), ...right]
    : left;
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group || '0'}`), 0n);
}

function inCidr(value, base, prefix, bits) {
  const shift = BigInt(bits - prefix);
  return value >> shift === base >> shift;
}

function positiveInteger(value, fallback, name) {
  if (value == null) {
    return fallback;
  }
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return normalized;
}

function nonNegativeInteger(value, fallback, name) {
  if (value == null) {
    return fallback;
  }
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return normalized;
}

function forwardAbort(signal, controller) {
  if (!signal) {
    return () => {};
  }
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => {};
  }
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function awaitWithAbort(promise, signal) {
  if (signal.aborted) {
    return Promise.reject(signal.reason || new DOMException('This operation was aborted', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('This operation was aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

function blockedAddressError(hostname, address) {
  return outboundError('OUTBOUND_ADDRESS_BLOCKED', `outbound host ${hostname} resolves to blocked address ${address}`);
}

function outboundError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

const IPV4_BLOCKS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([base, prefix]) => ({ base: parseIpv4(base), prefix }));

const IPV6_MAPPED_BASE = parseIpv6('::ffff:0:0');
const IPV6_COMPATIBLE_BASE = parseIpv6('::');
const NAT64_WELL_KNOWN_BASE = parseIpv6('64:ff9b::');
const NAT64_LOCAL_BASE = parseIpv6('64:ff9b:1::');
const SIX_TO_FOUR_BASE = parseIpv6('2002::');
const GLOBAL_UNICAST_BASE = parseIpv6('2000::');
const IPV6_BLOCKS = [
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
].map(([base, prefix]) => ({ base: parseIpv6(base), prefix }));

module.exports = {
  assertSafeOutboundUrl,
  fetchText,
};
