import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { getDb } from './database.js';
import logger from '../utils/logger.js';
import config from '../config.js';

/**
 * Get disk space information for the cache directory
 */
export function getDiskSpace(): { total: number; used: number; free: number } {
  try {
    const cacheDir = config.cacheDir;

    // Ensure cache dir exists for df command
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    // Use df to get disk info
    const output = execSync(`df -B1 "${cacheDir}"`, { encoding: 'utf-8' });
    const lines = output.trim().split('\n');
    if (lines.length < 2) {
      return { total: 0, used: 0, free: 0 };
    }

    const parts = lines[1].trim().split(/\s+/);
    const total = parseInt(parts[1], 10) || 0;
    const used = parseInt(parts[2], 10) || 0;
    const free = parseInt(parts[3], 10) || 0;

    return { total, used, free };
  } catch (err) {
    logger.error(`Error getting disk space: ${(err as Error).message}`);
    return { total: 0, used: 0, free: 0 };
  }
}

/**
 * Get total cache directory size in bytes
 */
export function getCacheSize(): number {
  try {
    const cacheDir = config.cacheDir;
    if (!fs.existsSync(cacheDir)) return 0;

    const output = execSync(`du -sb "${cacheDir}"`, { encoding: 'utf-8' });
    const parts = output.trim().split(/\s+/);
    return parseInt(parts[0], 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Get disk usage per movie
 */
export function getPerMovieDiskUsage(): Array<{ id: string; title: string; sizeBytes: number }> {
  const movies = getDb().prepare("SELECT id, title, info_hash FROM movies").all() as Array<{ id: string; title: string; info_hash: string }>;
  const result: Array<{ id: string; title: string; sizeBytes: number }> = [];

  for (const movie of movies) {
    const hashDir = path.join(config.cacheDir, movie.info_hash.toLowerCase());
    if (fs.existsSync(hashDir)) {
      try {
        const output = execSync(`du -sb "${hashDir}"`, { encoding: 'utf-8' });
        const sizeBytes = parseInt(output.trim().split(/\s+/)[0], 10) || 0;
        result.push({ id: movie.id, title: movie.title, sizeBytes });
      } catch {
        result.push({ id: movie.id, title: movie.title, sizeBytes: 0 });
      }
    } else {
      result.push({ id: movie.id, title: movie.title, sizeBytes: 0 });
    }
  }

  return result.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

/**
 * Check if there is enough disk space for a download
 */
export function checkDiskSpace(requiredBytes: number): { ok: boolean; freeBytes: number; message: string } {
  const disk = getDiskSpace();
  const minFreeBytes = 2 * requiredBytes;

  if (disk.free < minFreeBytes) {
    const freeGB = (disk.free / (1024 ** 3)).toFixed(2);
    const requiredGB = (minFreeBytes / (1024 ** 3)).toFixed(2);
    return {
      ok: false,
      freeBytes: disk.free,
      message: `Insufficient disk space. Need ${requiredGB} GB free, but only ${freeGB} GB available.`
    };
  }

  // Also check cache size limit
  const cacheSize = getCacheSize();
  const maxCacheBytes = config.maxCacheSizeGb * 1024 ** 3;
  if (cacheSize + requiredBytes > maxCacheBytes) {
    const cacheGB = (cacheSize / (1024 ** 3)).toFixed(2);
    const maxGB = config.maxCacheSizeGb;
    return {
      ok: false,
      freeBytes: disk.free,
      message: `Cache size limit reached. Current cache: ${cacheGB} GB, limit: ${maxGB} GB.`
    };
  }

  // Warn if free space is less than 20GB
  if (disk.free < 20 * 1024 ** 3) {
    logger.warn(`Low disk space: ${(disk.free / (1024 ** 3)).toFixed(2)} GB free`);
  }

  return {
    ok: true,
    freeBytes: disk.free,
    message: 'OK'
  };
}

/**
 * Delete a movie's cached files from disk
 */
export function deleteMovieFiles(infoHash: string): boolean {
  const hashDir = path.join(config.cacheDir, infoHash.toLowerCase());
  if (!fs.existsSync(hashDir)) return true;

  try {
    fs.rmSync(hashDir, { recursive: true, force: true });
    logger.info(`Deleted cache files for ${infoHash}`);
    return true;
  } catch (err) {
    logger.error(`Error deleting cache files for ${infoHash}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Delete all cached files from disk
 */
export function deleteAllCacheFiles(): number {
  const cacheDir = config.cacheDir;
  if (!fs.existsSync(cacheDir)) return 0;

  let count = 0;
  const entries = fs.readdirSync(cacheDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory() && /^[a-f0-9]{40}$/i.test(entry.name)) {
      try {
        fs.rmSync(path.join(cacheDir, entry.name), { recursive: true, force: true });
        count++;
      } catch (err) {
        logger.error(`Error deleting ${entry.name}: ${(err as Error).message}`);
      }
    }
  }

  logger.info(`Deleted all cache files (${count} directories)`);
  return count;
}

/**
 * Cleanup orphaned files and error-state movies
 */
export function cleanupOrphanedFiles(): { removedMovies: number; removedFiles: number } {
  let removedMovies = 0;
  let removedFiles = 0;

  // Remove movies with error status from DB
  const errorMovies = getDb().prepare("SELECT id, info_hash FROM movies WHERE status = 'error'").all() as Array<{ id: string; info_hash: string }>;

  for (const movie of errorMovies) {
    deleteMovieFiles(movie.info_hash);
    getDb().prepare('DELETE FROM movies WHERE id = ?').run(movie.id);
    removedMovies++;
  }

  // Find orphaned directories on disk
  const cacheDir = config.cacheDir;
  if (fs.existsSync(cacheDir)) {
    const entries = fs.readdirSync(cacheDir, { withFileTypes: true });
    const dbHashes = new Set(
      (getDb().prepare('SELECT info_hash FROM movies').all() as Array<{ info_hash: string }>)
        .map(r => r.info_hash.toLowerCase())
    );

    for (const entry of entries) {
      if (entry.isDirectory() && /^[a-f0-9]{40}$/i.test(entry.name)) {
        if (!dbHashes.has(entry.name.toLowerCase())) {
          try {
            fs.rmSync(path.join(cacheDir, entry.name), { recursive: true, force: true });
            removedFiles++;
            logger.info(`Removed orphaned cache directory: ${entry.name}`);
          } catch (err) {
            logger.error(`Error removing orphaned dir ${entry.name}: ${(err as Error).message}`);
          }
        }
      }
    }
  }

  logger.info(`Cleanup complete: ${removedMovies} error movies removed, ${removedFiles} orphaned files removed`);
  return { removedMovies, removedFiles };
}
