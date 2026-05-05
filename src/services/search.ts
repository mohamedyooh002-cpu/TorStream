import axios from 'axios';
import { TorrentSearchProvider, TorrentSearchResult } from '../types/index.js';
import logger from '../utils/logger.js';
import config from '../config.js';

// ============================================================
// Provider: YTS (YIFY) — public API, no auth needed
// ============================================================

class YTSProvider implements TorrentSearchProvider {
  name = 'YTS';
  private mirrors = [
    'https://yts.mx/api/v2',
    'https://yts.torrentbay.net/api/v2',
    'https://yts.proxyninja.org/api/v2',
    'https://yts-proxy.arungupta.me/api/v2'
  ];
  private baseUrl = 'https://yts.mx/api/v2';
  private lastRequestTime = 0;
  private minInterval = 3000; // 3 seconds between requests

  async search(query: string): Promise<TorrentSearchResult[]> {
    await this.rateLimit();

    for (const mirror of this.mirrors) {
      try {
        const results = await this.searchMirror(mirror, query);
        if (results.length > 0) {
          this.baseUrl = mirror;
          return results;
        }
      } catch {
        // try next mirror
      }
    }
    return [];
  }

  private async searchMirror(baseUrl: string, query: string): Promise<TorrentSearchResult[]> {
    try {
      const response = await axios.get(`${baseUrl}/list_movies.json`, {
        params: {
          query_term: query,
          limit: 20,
          sort_by: 'seeders',
          order_by: 'desc'
        },
        timeout: 10000
      });

      const data = response.data;
      if (!data || data.status !== 'ok' || !data.data || !data.data.movies) {
        return [];
      }

      const results: TorrentSearchResult[] = [];
      for (const movie of data.data.movies) {
        if (!movie.torrents) continue;

        for (const torrent of movie.torrents) {
          const infoHash = torrent.hash || this.extractHashFromMagnet(torrent.url);
          results.push({
            title: `${movie.title_long} ${torrent.quality} ${torrent.type}`,
            magnetUri: torrent.url || this.buildMagnetUri(infoHash, `${movie.title_long} ${torrent.quality}`),
            infoHash: infoHash,
            seeders: torrent.seeds || 0,
            leechers: torrent.peers || 0,
            size: torrent.size || '',
            sizeBytes: this.parseSizeToBytes(torrent.size || '0'),
            source: this.name,
            category: 'movies',
            uploadDate: torrent.date_uploaded || undefined
          });
        }
      }

      return results;
    } catch (err) {
      logger.error(`YTS mirror ${baseUrl} error: ${(err as Error).message}`);
      throw err;
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.baseUrl}/list_movies.json`, {
        params: { limit: 1 },
        timeout: 5000
      });
      return response.data && response.data.status === 'ok';
    } catch {
      return false;
    }
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minInterval - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  private extractHashFromMagnet(url: string): string {
    if (url.startsWith('magnet:?')) {
      const match = url.match(/btih:([a-fA-F0-9]{40})/i);
      if (match) return match[1].toLowerCase();
    }
    return '';
  }

  private buildMagnetUri(infoHash: string, title: string): string {
    return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://tracker.openbittorrent.com:6969/announce&tr=udp://open.stealth.si:80/announce&tr=udp://tracker.torrent.eu.org:451/announce&tr=udp://exodus.desync.com:6969/announce&tr=udp://tracker.tiny-vps.com:6969/announce`;
  }

  private parseSizeToBytes(sizeStr: string): number {
    if (!sizeStr) return 0;
    const match = sizeStr.match(/^([\d.]+)\s*(GB|MB|KB|TB)?$/i);
    if (!match) return 0;
    const num = parseFloat(match[1]);
    const unit = (match[2] || 'B').toUpperCase();
    const units: Record<string, number> = {
      B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4
    };
    return Math.round(num * (units[unit] || 1));
  }
}

// ============================================================
// Provider: 1337x — web scrape via public search
// ============================================================

class LeetxProvider implements TorrentSearchProvider {
  name = '1337x';
  private baseUrl = 'https://1337x.to';
  private lastRequestTime = 0;
  private minInterval = 3000;

  async search(query: string): Promise<TorrentSearchResult[]> {
    await this.rateLimit();

    try {
      const searchUrl = `${this.baseUrl}/search/${encodeURIComponent(query)}/1/`;
      const response = await axios.get(searchUrl, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });

      const html = response.data as string;
      return this.parseSearchResults(html);
    } catch (err) {
      logger.error(`1337x search error: ${(err as Error).message}`);
      return [];
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await axios.get(this.baseUrl, {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  private parseSearchResults(html: string): TorrentSearchResult[] {
    const results: TorrentSearchResult[] = [];

    // Parse the torrent list table from HTML
    const rowRegex = /<tr>[\s\S]*?<a\s+href="\/torrent\/(\d+)\/([^"]+)"[\s\S]*?<td\s+class="coll-2\s+seeds">(\d+)<\/td>[\s\S]*?<td\s+class="coll-3\s+leeches">(\d+)<\/td>[\s\S]*?<td\s+class="coll-4\s+size\s+mobile-hide">([^<]+)<\/td>/gi;

    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const torrentId = match[1];
      const slugTitle = match[2].replace(/-/g, ' ');
      const seeders = parseInt(match[3], 10) || 0;
      const leechers = parseInt(match[4], 10) || 0;
      const sizeStr = match[5].trim();

      // We need to fetch the magnet from the detail page — for now, use a placeholder
      // The detail page fetch is done lazily when user tries to download
      results.push({
        title: slugTitle,
        magnetUri: '', // Will be resolved on demand
        infoHash: torrentId, // Temporary — will be replaced with real hash
        seeders,
        leechers,
        size: sizeStr,
        sizeBytes: this.parseSizeStr(sizeStr),
        source: this.name,
        category: 'movies',
        uploadDate: undefined
      });
    }

    return results;
  }

  /**
   * Fetch the magnet URI from a 1337x detail page
   */
  async resolveMagnetUri(detailPath: string): Promise<{ magnetUri: string; infoHash: string } | null> {
    try {
      const url = `${this.baseUrl}${detailPath}`;
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const html = response.data as string;
      const magnetMatch = html.match(/href="(magnet:\?[^"]+)"/i);
      if (magnetMatch) {
        const magnetUri = magnetMatch[1].replace(/&amp;/g, '&');
        const hashMatch = magnetUri.match(/btih:([a-fA-F0-9]{40})/i);
        const infoHash = hashMatch ? hashMatch[1].toLowerCase() : '';
        return { magnetUri, infoHash };
      }
      return null;
    } catch (err) {
      logger.error(`1337x magnet resolve error: ${(err as Error).message}`);
      return null;
    }
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minInterval - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  private parseSizeStr(sizeStr: string): number {
    if (!sizeStr) return 0;
    const match = sizeStr.match(/([\d.]+)\s*(GB|MB|KB|TB|B)/i);
    if (!match) return 0;
    const num = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    const units: Record<string, number> = {
      B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4
    };
    return Math.round(num * (units[unit] || 1));
  }
}

// ============================================================
// Provider: ThePirateBay — via public API proxies
// ============================================================

class PirateBayProvider implements TorrentSearchProvider {
  name = 'ThePirateBay';
  private mirrors = [
    'https://apibay.org',
    'https://apibay.net',
  ];
  private lastRequestTime = 0;
  private minInterval = 3000;

  async search(query: string): Promise<TorrentSearchResult[]> {
    await this.rateLimit();

    for (const mirror of this.mirrors) {
      try {
        // Search all video categories (200) for broadest results
        const response = await axios.get(`${mirror}/q.php`, {
          params: { q: query, cat: 200 },
          timeout: 10000
        });

        const data = response.data;
        if (!Array.isArray(data)) continue;

        const results = data
          .filter((item: Record<string, string>) => item.id !== '0' && item.id !== undefined)
          .map((item: Record<string, string>) => {
            // apibay may use info_hash or infohash depending on version
            const hash = (item.info_hash || item.infohash || item.hash || '').toLowerCase();
            const sizeBytes = parseInt(item.size, 10) || 0;
            return {
              title: item.name || '',
              magnetUri: this.buildMagnet(hash, item.name || ''),
              infoHash: hash,
              seeders: parseInt(item.seeders, 10) || 0,
              leechers: parseInt(item.leechers, 10) || 0,
              size: this.formatBytes(sizeBytes),
              sizeBytes,
              source: this.name,
              category: 'movies',
              uploadDate: item.added ? new Date(parseInt(item.added, 10) * 1000).toISOString() : undefined
            };
          });

        const validResults = results.filter(r => r.infoHash.length >= 10);
        logger.debug(`TPB mirror ${mirror}: ${data.length} raw → ${validResults.length} with valid hash`);
        if (validResults.length > 0) return validResults;
      } catch (err) {
        logger.error(`ThePirateBay mirror ${mirror} error: ${(err as Error).message}`);
      }
    }
    return [];
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.mirrors[0]}/q.php`, {
        params: { q: 'test', cat: 0 },
        timeout: 5000
      });
      return Array.isArray(response.data);
    } catch {
      return false;
    }
  }

  private buildMagnet(infoHash: string, name: string): string {
    const trackers = [
      'udp://tracker.opentrackr.org:1337/announce',
      'udp://tracker.openbittorrent.com:6969/announce',
      'udp://open.stealth.si:80/announce',
      'udp://tracker.torrent.eu.org:451/announce',
      'udp://exodus.desync.com:6969/announce',
      'udp://tracker.tiny-vps.com:6969/announce',
      'udp://p4p.arenabg.com:1337/announce',
      'udp://tracker.moeking.me:6969/announce'
    ];
    const tr = trackers.map(t => `&tr=${encodeURIComponent(t)}`).join('');
    return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}${tr}`;
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minInterval - elapsed));
    }
    this.lastRequestTime = Date.now();
  }
}

// ============================================================
// Provider: SolidTorrents — clean public REST API
// ============================================================

class SolidTorrentsProvider implements TorrentSearchProvider {
  name = 'SolidTorrents';
  private baseUrl = 'https://solidtorrents.to/api/v1';
  private lastRequestTime = 0;
  private minInterval = 2000;

  async search(query: string): Promise<TorrentSearchResult[]> {
    await this.rateLimit();
    try {
      const response = await axios.get(`${this.baseUrl}/search`, {
        params: {
          q: query,
          sort: 'seeders',
          _limit: 30,
          category: 'Video'
        },
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });

      const data = response.data;
      const results = data?.results || data?.torrents || [];
      if (!Array.isArray(results)) return [];

      return results.map((item: Record<string, unknown>) => {
        const swarm = (item.swarm as Record<string, number>) || {};
        const sizeBytes = (item.size as number) || 0;
        const hash = ((item.infohash || item.info_hash || '') as string).toLowerCase();
        return {
          title: (item.title as string) || '',
          magnetUri: (item.magnet as string) || this.buildMagnet(hash, (item.title as string) || ''),
          infoHash: hash,
          seeders: swarm.seeders || 0,
          leechers: swarm.leechers || 0,
          size: this.formatBytes(sizeBytes),
          sizeBytes,
          source: this.name,
          category: 'movies',
          uploadDate: (item.imported as string) || undefined
        };
      }).filter((r: TorrentSearchResult) => r.infoHash.length >= 10);
    } catch (err) {
      logger.error(`SolidTorrents search error: ${(err as Error).message}`);
      return [];
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.baseUrl}/search`, {
        params: { q: 'test', _limit: 1 },
        timeout: 5000
      });
      return !!response.data;
    } catch {
      return false;
    }
  }

  private buildMagnet(infoHash: string, name: string): string {
    return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}&tr=udp://tracker.opentrackr.org:1337/announce`;
  }

  private formatBytes(bytes: number): string {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minInterval - elapsed));
    }
    this.lastRequestTime = Date.now();
  }
}

// ============================================================
// Provider: EZTV — public API for movies/TV
// ============================================================

class EZTVProvider implements TorrentSearchProvider {
  name = 'EZTV';
  private baseUrl = 'https://eztv.re/api';
  private lastRequestTime = 0;
  private minInterval = 3000;

  async search(query: string): Promise<TorrentSearchResult[]> {
    await this.rateLimit();
    try {
      const response = await axios.get(`${this.baseUrl}/get-torrents`, {
        params: { keywords: query, limit: 100 },
        timeout: 10000
      });
      const data = response.data;
      if (!data || !Array.isArray(data.torrents)) return [];

      // EZTV API often ignores the keywords param — filter client-side
      const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
      const relevant = data.torrents.filter((item: Record<string, string | number>) => {
        const title = (item.title as string || '').toLowerCase();
        return queryWords.some(word => title.includes(word));
      });

      return relevant.map((item: Record<string, string | number>) => ({
        title: item.title as string || '',
        magnetUri: item.magnet_url as string || '',
        infoHash: (item.hash as string || '').toLowerCase(),
        seeders: parseInt(String(item.seeds), 10) || 0,
        leechers: parseInt(String(item.peers), 10) || 0,
        size: this.formatBytes(parseInt(String(item.size_bytes), 10) || 0),
        sizeBytes: parseInt(String(item.size_bytes), 10) || 0,
        source: this.name,
        category: 'movies',
        uploadDate: item.date_released_unix
          ? new Date((item.date_released_unix as number) * 1000).toISOString()
          : undefined
      }));
    } catch (err) {
      logger.error(`EZTV search error: ${(err as Error).message}`);
      return [];
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.baseUrl}/get-torrents`, {
        params: { keywords: 'test', limit: 1 },
        timeout: 5000
      });
      return !!response.data;
    } catch {
      return false;
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minInterval - elapsed));
    }
    this.lastRequestTime = Date.now();
  }
}

// ============================================================
// Search Manager — coordinates providers with failover
// ============================================================

const providers: TorrentSearchProvider[] = [
  new YTSProvider(),
  new PirateBayProvider(),
  new SolidTorrentsProvider(),
  new EZTVProvider(),
  new LeetxProvider()
];

/**
 * Search all providers and return unified, filtered, deduplicated results
 */
export async function searchTorrents(query: string): Promise<TorrentSearchResult[]> {
  const maxFileSizeBytes = config.maxFileSizeGb * 1024 * 1024 * 1024;
  const minFileSizeBytes = config.minFileSizeMb * 1024 * 1024;
  const minSeeders = config.minSeeders;

  logger.info(`Searching torrents for: "${query}"`);

  const allResults: TorrentSearchResult[] = [];

  // Search all providers concurrently with timeouts
  const searchPromises = providers.map(provider =>
    provider.search(query)
      .then(results => {
        logger.info(`Provider ${provider.name} returned ${results.length} results`);
        return results;
      })
      .catch(err => {
        logger.warn(`Provider ${provider.name} failed: ${err.message}`);
        return [];
      })
  );

  const providerResults = await Promise.allSettled(searchPromises);

  for (const result of providerResults) {
    if (result.status === 'fulfilled') {
      allResults.push(...result.value);
    }
  }

  // Deduplicate by infoHash
  const seen = new Map<string, TorrentSearchResult>();
  for (const result of allResults) {
    if (!result.infoHash || result.infoHash.length < 10) continue;
    const key = result.infoHash.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, result);
    } else {
      const existing = seen.get(key)!;
      if (result.seeders > existing.seeders) {
        seen.set(key, result);
      }
    }
  }

  let filtered = Array.from(seen.values());
  logger.debug(`After dedup: ${filtered.length} (dropped ${allResults.length - filtered.length} dupes/no-hash)`);

  // Filter: relevance — title must contain at least one query word
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  if (queryWords.length > 0) {
    const before = filtered.length;
    filtered = filtered.filter(r => {
      const title = (r.title || '').toLowerCase();
      return queryWords.some(word => title.includes(word));
    });
    logger.debug(`After relevance filter: ${filtered.length} (dropped ${before - filtered.length})`);
  }

  // Filter: remove non-video categories
  const blockedCategories = ['games', 'software', 'music', 'xxx', 'ebooks', 'applications'];
  const before1 = filtered.length;
  filtered = filtered.filter(r => {
    const cat = (r.category || '').toLowerCase();
    return !blockedCategories.some(bc => cat.includes(bc));
  });
  logger.debug(`After category filter: ${filtered.length} (dropped ${before1 - filtered.length})`);

  // Filter: minimum seeders
  const before2 = filtered.length;
  filtered = filtered.filter(r => r.seeders >= minSeeders);
  logger.debug(`After seeders filter (min ${minSeeders}): ${filtered.length} (dropped ${before2 - filtered.length})`);

  // Filter: max file size
  const before3 = filtered.length;
  filtered = filtered.filter(r => r.sizeBytes === 0 || r.sizeBytes <= maxFileSizeBytes);
  logger.debug(`After max-size filter: ${filtered.length} (dropped ${before3 - filtered.length})`);

  // Filter: min file size (skip if sizeBytes is 0/unknown)
  const before4 = filtered.length;
  filtered = filtered.filter(r => r.sizeBytes === 0 || r.sizeBytes >= minFileSizeBytes);
  logger.debug(`After min-size filter (min ${config.minFileSizeMb}MB): ${filtered.length} (dropped ${before4 - filtered.length})`);

  // Sort by seeders DESC
  filtered.sort((a, b) => b.seeders - a.seeders);

  logger.info(`Search complete: ${filtered.length} results after filtering (from ${allResults.length} raw)`);
  return filtered;
}

/**
 * Resolve magnet URI for a 1337x result that needs it
 */
export async function resolveMagnetUri(source: string, detailPath: string): Promise<{ magnetUri: string; infoHash: string } | null> {
  if (source === '1337x') {
    const leetxProvider = providers.find(p => p.name === '1337x') as LeetxProvider;
    if (leetxProvider && detailPath) {
      return leetxProvider.resolveMagnetUri(detailPath);
    }
  }
  return null;
}

/**
 * Get all available providers
 */
export function getProviders(): TorrentSearchProvider[] {
  return providers;
}

/**
 * Test all provider connections
 */
export async function testAllProviders(): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};
  for (const provider of providers) {
    try {
      results[provider.name] = await provider.testConnection();
    } catch {
      results[provider.name] = false;
    }
  }
  return results;
}
