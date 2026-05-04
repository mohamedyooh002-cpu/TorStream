import path from 'path';
import { QualityInfo } from '../types/index.js';

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Parse human readable size to bytes
 */
export function parseSizeToBytes(sizeStr: string): number {
  if (!sizeStr) return 0;
  const match = sizeStr.match(/^([\d.]+)\s*(B|KB|MB|GB|TB|PB)?$/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = (match[2] || 'B').toUpperCase();
  const units: Record<string, number> = {
    B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, PB: 1024 ** 5
  };
  return num * (units[unit] || 1);
}

/**
 * Extract quality information from a torrent title
 */
export function extractQuality(title: string): QualityInfo {
  const lower = title.toLowerCase();
  const camKeywords = ['cam', 'hdcam', 'tsrip', 'pdvd', 'predvd', 'camrip', 'hdtc'];
  const isCam = camKeywords.some(kw => lower.includes(kw));

  if (lower.includes('2160p') || lower.includes('4k') || lower.includes('uhd')) {
    return { quality: '4K', isCam };
  }
  if (lower.includes('1080p')) {
    return { quality: '1080p', isCam };
  }
  if (lower.includes('720p')) {
    return { quality: '720p', isCam };
  }
  if (lower.includes('480p')) {
    return { quality: '480p', isCam };
  }
  if (isCam) {
    return { quality: 'CAM', isCam: true };
  }
  return { quality: 'Unknown', isCam };
}

/**
 * Parse a torrent title to extract a probable movie name
 * Removes quality tags, release group tags, extensions, etc.
 */
export function parseMovieName(torrentTitle: string): string {
  let name = torrentTitle;

  // Remove file extensions
  name = name.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|rar|zip|nfo|srt|sub)$/gi, '');

  // Remove anything in brackets or parentheses that looks technical
  name = name.replace(/[\[\(][^\]\)]*[\]\)]/g, '');

  // Remove quality tags
  const qualityTags = [
    '2160p', '1080p', '720p', '480p', '360p',
    '4K', 'UHD', 'HDRip', 'BRRip', 'BR Rip',
    'WEBRip', 'WEB Rip', 'WEB-DL', 'WEBDL',
    'Bluray', 'Blu-Ray', 'BDRip', 'BD Rip',
    'DVDRip', 'DVD Rip', 'DVDScr', 'HDTV',
    'CAMRip', 'CAM', 'HDCAM', 'HDTC', 'TCRip', 'TSRip', 'PDVD', 'PreDVD',
    'x264', 'x265', 'H264', 'H265', 'HEVC', 'H.264', 'H.265',
    'AAC', 'AC3', 'DTS', 'DD5.1', 'DD+5.1', 'Atmos',
    '10bit', '8bit', 'HDR', 'SDR',
    'YTS', 'YIFY', 'ETRG', 'RARBG', 'JiNx', 'FGT',
    'FUM', 'DIMENSION', 'LOL', 'KILLERS', '2HD',
    'LiGaS', 'SaM', 'Ozlem', 'EVO', 'ION10',
    'Tigole', 'Joy', 'ANiHLS', 'Beta', 'SPARKS',
    'Grym', 'BMF', 'iFT', 'CRiSC', 'TiTAN',
    'PROPER', 'REPACK', 'REMUX', 'COMPLETE',
    'NF', 'AMZN', 'HMAX', 'DSNP', 'HULU',
    'DUAL', 'DUBBED', 'SUBBED', 'MULTI',
    'NORDIC', 'GERMAN', 'FRENCH', 'SPANISH',
    'ITA', 'JAP', 'KOR', 'CHN', 'HINDI',
    'ENG', 'ENGLISH'
  ];

  for (const tag of qualityTags) {
    const regex = new RegExp(`[\\s.\\-]${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s.\\-]|^${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s.\\-]|[\\s.\\-]${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'gi');
    name = name.replace(regex, ' ');
  }

  // Remove year patterns temporarily, save for later
  const yearMatch = name.match(/\b(19|20)\d{2}\b/);
  let year = '';
  if (yearMatch) {
    year = yearMatch[0];
  }

  // Clean up
  name = name.replace(/[._\-]+/g, ' ');
  name = name.replace(/\s+/g, ' ').trim();

  // Add year back if found
  if (year) {
    name = name.replace(new RegExp(`\\s*${year}\\s*`, 'g'), ' ').trim();
    name = name + ' ' + year;
  }

  return name.trim();
}

/**
 * Extract year from torrent title
 */
export function extractYear(title: string): string | null {
  const match = title.match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : null;
}

/**
 * Generate a safe filename from a string
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .substring(0, 200);
}

/**
 * Get the absolute cache directory path
 */
export function getCacheDir(): string {
  const envDir = process.env.CACHE_DIR || './cache/videos';
  return path.resolve(envDir);
}

/**
 * Get directory for a specific infoHash
 */
export function getHashDir(infoHash: string): string {
  return path.join(getCacheDir(), infoHash.toLowerCase());
}

/**
 * Get HLS directory for a specific infoHash
 */
export function getHlsDir(infoHash: string): string {
  return path.join(getHashDir(infoHash), 'hls');
}

/**
 * Delay for a specified number of milliseconds
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Truncate a string to a maximum length with ellipsis
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}
