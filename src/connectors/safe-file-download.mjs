import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { TextDecoder } from 'node:util';

export const MAX_FILE_CONTENT_BYTES = 1_048_576;
const MAX_URL_LENGTH = 16_384;
const DEFAULT_TIMEOUT_MS = 15_000;
// Conservatively block IANA special-use ranges, including the whole 192.0.0.0/24.
const NON_PUBLIC_IPV4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
];

export class SafeFileDownloadError extends Error {
  constructor(code) {
    super(`Selected file download: ${code}`);
    this.name = 'SafeFileDownloadError';
    this.code = code;
  }
}

function fail(code) {
  throw new SafeFileDownloadError(code);
}

function ipv4Number(address) {
  if (isIP(address) !== 4) return null;
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
    return null;
  }
  return octets.reduce((value, octet) => value * 256 + octet, 0);
}

function inRange(address, network, prefix) {
  const value = ipv4Number(address);
  const base = ipv4Number(network);
  if (value === null || base === null) return true;
  const shift = 32 - prefix;
  return Math.floor(value / 2 ** shift) === Math.floor(base / 2 ** shift);
}

function isPublicIpv4(address) {
  return ipv4Number(address) !== null &&
    NON_PUBLIC_IPV4.every(([network, prefix]) => !inRange(address, network, prefix));
}

export function normalizeApprovedHost(host) {
  if (typeof host !== 'string' || host.length > 253 || host !== host.trim() ||
      host !== host.toLowerCase() || host.endsWith('.') || isIP(host) ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) {
    fail('invalid_content_host');
  }
  return host;
}

export function validateApprovedHttpsUrl(value, approvedHost) {
  const hostname = normalizeApprovedHost(approvedHost);
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH ||
      value !== value.trim() || /[\u0000-\u0020\u007f\\]/.test(value)) {
    fail('blocked_request');
  }
  const parts = /^https:\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?$/i.exec(value);
  if (!parts) fail('blocked_request');
  const authority = parts[1];
  if (authority.includes('@') || authority.includes(':') || authority.includes('%') ||
      authority.includes('[') || authority.includes(']')) fail('blocked_request');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('blocked_request');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.hash || url.hostname !== hostname || authority.toLowerCase() !== hostname) {
    fail('blocked_request');
  }
  const rawPath = parts[2] || '/';
  for (const component of rawPath.split('/')) {
    let decoded;
    try {
      decoded = decodeURIComponent(component);
    } catch {
      fail('blocked_request');
    }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') ||
        decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded)) fail('blocked_request');
    if (/%[0-9a-f]{2}/i.test(decoded)) fail('blocked_request');
  }
  return { hostname, path: `${rawPath}${parts[3] || ''}` };
}

async function resolveIpv4(hostname) {
  return dnsLookup(hostname, { all: true, family: 4, verbatim: true });
}

function checkSignal(signal, timedOut) {
  if (timedOut()) fail('timeout');
  if (signal?.aborted) fail('cancelled');
}

export function environmentProxyConfigured({
  env = process.env, platform = process.platform, execArgv = process.execArgv
} = {}) {
  const proxyNames = [
    'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy',
    'npm_config_https_proxy', 'NPM_CONFIG_HTTPS_PROXY',
    'npm_config_http_proxy', 'NPM_CONFIG_HTTP_PROXY',
    'npm_config_proxy', 'NPM_CONFIG_PROXY',
    'GLOBAL_AGENT_HTTP_PROXY', 'GLOBAL_AGENT_HTTPS_PROXY'
  ];
  const nodeOptions = typeof env.NODE_OPTIONS === 'string' ? env.NODE_OPTIONS : '';
  const nodeEnvProxyFlag = /(?:^|[\s"'`])--use-env-proxy(?=$|[\s"'`=])/.test(nodeOptions);
  return platform === 'win32' ||
    proxyNames.some(name => typeof env[name] === 'string' && env[name].trim().length > 0) ||
    Boolean(env.NODE_USE_ENV_PROXY && env.NODE_USE_ENV_PROXY !== '0') ||
    nodeEnvProxyFlag ||
    execArgv.some(argument => /^--use-env-proxy(?:$|=)/.test(argument)) ||
    env.NODE_TLS_REJECT_UNAUTHORIZED === '0';
}

export function directFileEgressAllowed(allowDirectEgress, proxyConfigured = environmentProxyConfigured) {
  return allowDirectEgress === true && !proxyConfigured();
}

export function createSafeFileDownloader({
  resolve = resolveIpv4,
  request = httpsRequest,
  allowDirectEgress = false,
  proxyConfigured = environmentProxyConfigured
} = {}) {
  return async function downloadText({ url, approvedHost, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const target = validateApprovedHttpsUrl(url, approvedHost);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60_000) fail('invalid_timeout');
    if (!directFileEgressAllowed(allowDirectEgress, proxyConfigured)) fail('network_policy_unavailable');

    let requestHandle;
    let expired = false;
    let timeout;
    let onAbort;
    const terminating = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        expired = true;
        requestHandle?.destroy(new Error('timeout'));
        reject(new SafeFileDownloadError('timeout'));
      }, timeoutMs);
      onAbort = () => {
        requestHandle?.destroy(new Error('cancelled'));
        reject(new SafeFileDownloadError('cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });

    const operation = (async () => {
      checkSignal(signal, () => expired);
      let answers;
      try {
        answers = await resolve(target.hostname);
      } catch {
        checkSignal(signal, () => expired);
        fail('transport_error');
      }
      checkSignal(signal, () => expired);
      if (!Array.isArray(answers) || !answers.length ||
          answers.some(answer => !answer || answer.family !== 4 || !isPublicIpv4(answer.address))) {
        fail('blocked_request');
      }
      const pinnedAddress = answers[0].address;

      return new Promise((resolveText, rejectText) => {
        let response;
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          if (error) {
            response?.destroy();
            requestHandle?.destroy();
            rejectText(error);
          } else resolveText(value);
        };
        const failRequest = code => finish(new SafeFileDownloadError(code));
        const pinnedLookup = (hostname, options, callback) => {
          const done = typeof options === 'function' ? options : callback;
          const lookupOptions = typeof options === 'function' ? undefined : options;
          if (typeof done !== 'function') return;
          if (hostname.toLowerCase() !== target.hostname) {
            done(new Error('Host mismatch'));
          } else if (lookupOptions?.all) {
            done(null, [{ address: pinnedAddress, family: 4 }]);
          } else {
            done(null, pinnedAddress, 4);
          }
        };
        try {
          requestHandle = request({
            hostname: target.hostname,
            port: 443,
            path: target.path,
            method: 'GET',
            servername: target.hostname,
            rejectUnauthorized: true,
            agent: false,
            lookup: pinnedLookup,
            headers: { Accept: 'text/plain', 'Accept-Encoding': 'identity' }
          }, incoming => {
            response = incoming;
            if (incoming.statusCode !== 200) {
              failRequest(incoming.statusCode >= 300 && incoming.statusCode < 400
                ? 'blocked_request' : 'transport_error');
              return;
            }
            const headers = incoming.headers || {};
            const contentType = headers['content-type'];
            const contentEncoding = headers['content-encoding'];
            if (typeof contentType !== 'string' ||
                !/^text\/plain(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(contentType.trim()) ||
                (contentEncoding !== undefined && String(contentEncoding).toLowerCase() !== 'identity')) {
              failRequest('file_content_unavailable');
              return;
            }
            const declaredLength = headers['content-length'];
            let expectedLength;
            if (declaredLength !== undefined) {
              if (typeof declaredLength !== 'string' || !/^(0|[1-9]\d*)$/.test(declaredLength) ||
                  !Number.isSafeInteger(Number(declaredLength))) {
                failRequest('invalid_response');
                return;
              }
              expectedLength = Number(declaredLength);
              if (expectedLength > MAX_FILE_CONTENT_BYTES) {
                failRequest('response_too_large');
                return;
              }
            }
            const chunks = [];
            let total = 0;
            incoming.on('data', chunk => {
              if (settled) return;
              const bytes = Buffer.from(chunk);
              total += bytes.byteLength;
              if (total > MAX_FILE_CONTENT_BYTES) {
                failRequest('response_too_large');
                return;
              }
              chunks.push(bytes);
            });
            incoming.on('aborted', () => failRequest('transport_error'));
            incoming.on('error', () => failRequest('transport_error'));
            incoming.on('end', () => {
              if (expectedLength !== undefined && total !== expectedLength) {
                failRequest('invalid_response');
                return;
              }
              try {
                finish(null, new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)));
              } catch {
                failRequest('invalid_content_encoding');
              }
            });
          });
          requestHandle.on('error', () => failRequest('transport_error'));
          requestHandle.end();
        } catch {
          failRequest('transport_error');
        }
      });
    })();

    try {
      return await Promise.race([operation, terminating]);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}

export const downloadSafeTextFile = createSafeFileDownloader();
