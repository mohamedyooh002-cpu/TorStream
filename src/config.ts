import dotenv from 'dotenv';
import path from 'path';
import { AppConfig } from './types/index.js';
import logger from './utils/logger.js';

dotenv.config();

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const num = parseInt(value, 10);
  if (isNaN(num)) {
    logger.warn(`Invalid number for env ${key}, using default: ${defaultValue}`);
    return defaultValue;
  }
  return num;
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

const config: AppConfig = {
  port: getEnvNumber('PORT', 3000),
  host: getEnv('HOST', '0.0.0.0'),
  nodeEnv: getEnv('NODE_ENV', 'development'),
  adminUsername: getEnv('ADMIN_USERNAME', 'admin'),
  adminPassword: getEnv('ADMIN_PASSWORD', 'admin123'),
  jwtSecret: getEnv('JWT_SECRET', 'dev-secret-key-change-in-production'),
  cacheDir: path.resolve(getEnv('CACHE_DIR', './cache/videos')),
  maxCacheSizeGb: getEnvNumber('MAX_CACHE_SIZE_GB', 500),
  maxFileSizeGb: getEnvNumber('MAX_FILE_SIZE_GB', 15),
  minFileSizeMb: getEnvNumber('MIN_FILE_SIZE_MB', 100),
  minSeeders: getEnvNumber('MIN_SEEDERS', 5),
  maxConcurrentDownloads: getEnvNumber('MAX_CONCURRENT_DOWNLOADS', 2),
  seedAfterDownload: getEnvBool('SEED_AFTER_DOWNLOAD', true),
  downloadTimeoutMinutes: getEnvNumber('DOWNLOAD_TIMEOUT_MINUTES', 60),
  omdbApiKey: getEnv('OMDB_API_KEY', ''),
  torrentPort: getEnvNumber('TORRENT_PORT', 6881),
  dhtEnabled: getEnvBool('DHT_ENABLED', true),
  searchRateLimitPerMin: getEnvNumber('SEARCH_RATE_LIMIT_PER_MIN', 10),
  downloadRequestRateLimitPerHour: getEnvNumber('DOWNLOAD_REQUEST_RATE_LIMIT_PER_HOUR', 60),
  corsOrigin: getEnv('CORS_ORIGIN', '*')
};

logger.info('Configuration loaded', {
  port: config.port,
  nodeEnv: config.nodeEnv,
  cacheDir: config.cacheDir,
  maxConcurrentDownloads: config.maxConcurrentDownloads,
  omdbApiKeySet: !!config.omdbApiKey
});

export default config;
