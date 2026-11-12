import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

export function isDashboardUrl(candidate, origin) {
  try {
    const url = new URL(candidate);
    return url.origin === origin && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isExternalWebUrl(candidate) {
  try {
    const url = new URL(candidate);
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username && !url.password;
  } catch {
    return false;
  }
}

export async function startOwnedServer({ serverPath, dataDir, fetchImpl = fetch }) {
  const { startServer } = await import(pathToFileURL(serverPath).href);
  const backend = await startServer({ dataDir, port: 0 });
  try {
    let url;
    let launch;
    try {
      if (typeof backend.url !== 'string' || typeof backend.launchUrl !== 'string') throw new Error();
      url = new URL(backend.url);
      launch = new URL(backend.launchUrl);
    } catch {
      throw new Error('The local server returned an invalid endpoint or launch URL.');
    }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
        !url.port || url.username || url.password || url.pathname !== '/' ||
        url.search || url.hash || backend.url !== url.origin ||
        typeof backend.close !== 'function') {
      throw new Error('The local server returned an invalid endpoint or shutdown handle.');
    }
    if (launch.origin !== url.origin || launch.username || launch.password ||
        launch.pathname !== url.pathname || launch.search || !launch.hash ||
        typeof backend.accessToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(backend.accessToken) ||
        backend.launchUrl !== `${backend.url}/#access=${backend.accessToken}`) {
      throw new Error('The local server returned an invalid launch capability.');
    }
    const response = await fetchImpl(new URL('/api/health', url), {
      signal: AbortSignal.timeout(10000), redirect: 'error'
    });
    if (!response.ok) throw new Error(`Local health check failed (HTTP ${response.status}).`);
    return backend;
  } catch (error) {
    if (backend && typeof backend.close === 'function') await backend.close();
    throw error;
  }
}

export function workspaceServerPath({ isPackaged, resourcesPath, desktopDir }) {
  return isPackaged
    ? join(resourcesPath, 'workspace', 'src', 'server.mjs')
    : join(desktopDir, '..', 'src', 'server.mjs');
}
