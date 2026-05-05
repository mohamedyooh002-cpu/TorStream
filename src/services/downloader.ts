import WebTorrent from 'webtorrent';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DownloadJob } from '../types/index.js';
import { insertMovie, updateMovie, getMovieByInfoHash, insertDownloadLog, updateDownloadLog, deleteMovie } from './database.js';
import { convertToHls } from './hls-converter.js';
import { getHashDir, getHlsDir } from '../utils/helpers.js';
import logger from '../utils/logger.js';
import config from '../config.js';
import { Server as SocketServer } from 'socket.io';

let io: SocketServer;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;

const activeJobs = new Map<string, DownloadJob>();
const downloadQueue: Array<{
  magnetUri: string;
  infoHash: string;
  title: string;
  source: string;
  sizeBytes: number;
  seeders: number;
  leechers: number;
}> = [];

let isProcessingQueue = false;

/**
 * Initialize the WebTorrent client
 */
export function initDownloader(socketIo: SocketServer): void {
  io = socketIo;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client = new (WebTorrent as any)({
    maxConns: 100,
    tracker: true,
    dht: config.dhtEnabled,
    utp: true
  });

  client.on('error', (err: Error) => {
    logger.error(`WebTorrent client error: ${err.message}`);
  });

  logger.info('WebTorrent client initialized', {
    torrentPort: config.torrentPort,
    dhtEnabled: config.dhtEnabled
  });
}

/**
 * Add a torrent to the download queue
 */
export async function queueDownload(options: {
  magnetUri: string;
  infoHash: string;
  title: string;
  source: string;
  sizeBytes?: number;
  seeders?: number;
  leechers?: number;
  streamOnly?: boolean;
}): Promise<{ jobId: string; movieId: string; status: string; streamOnly?: boolean }> {
  const { magnetUri, infoHash, title, source, sizeBytes, seeders, leechers, streamOnly } = options;
  const hash = infoHash.toLowerCase();

  // Check if already cached on disk
  const hashDir = getHashDir(hash);
  const hlsDir = getHlsDir(hash);

  // Check if already in the database
  const existingMovie = getMovieByInfoHash(hash);
  if (existingMovie && existingMovie.status === 'ready') {
    // Already on disk — stream from cache (no cleanup needed regardless of streamOnly flag)
    return { jobId: '', movieId: existingMovie.id, status: 'already_cached', streamOnly: false };
  }

  // If this exact torrent is already active, treat repeated clicks as idempotent.
  const existingActiveJob = Array.from(activeJobs.values())
    .find(j => j.infoHash === hash && (j.status === 'downloading' || j.status === 'converting'));
  if (existingActiveJob && existingMovie) {
    return { jobId: existingActiveJob.id, movieId: existingMovie.id, status: 'downloading', streamOnly: false };
  }

  // Check if video file already exists on disk
  if (fs.existsSync(hashDir)) {
    const videoFile = findVideoFile(hashDir);
    if (videoFile) {
      logger.info(`Video already cached on disk: ${hash}`);

      if (!existingMovie) {
        const hasHls = fs.existsSync(path.join(hlsDir, 'master.m3u8'));
        const movieId = insertMovie({
          info_hash: hash,
          title: title,
          original_torrent_title: title,
          quality: extractQualityTag(title),
          seeders: seeders ?? undefined,
          leechers: leechers ?? undefined,
          size_bytes: sizeBytes ?? undefined,
          hls_path: hasHls ? path.join(hlsDir, 'master.m3u8') : undefined,
          video_path: videoFile,
          status: 'ready',
          torrent_source: source
        });

        // If HLS doesn't exist yet, try conversion (gracefully skip if ffmpeg missing)
        if (!hasHls) {
          convertToHls(movieId, hash, videoFile).catch((err) => {
            logger.warn(`HLS conversion skipped (no ffmpeg): ${(err as Error).message}`);
          });
        }

        return { jobId: '', movieId, status: 'cached_from_disk', streamOnly: false };
      } else {
        // Movie exists in DB but maybe needs HLS — mark ready regardless so direct streaming works
        if (!existingMovie.hls_path || !fs.existsSync(existingMovie.hls_path)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          updateMovie(existingMovie.id, { status: 'ready', video_path: videoFile } as any);
          convertToHls(existingMovie.id, hash, videoFile).catch((err) => {
            logger.warn(`HLS conversion skipped (no ffmpeg): ${(err as Error).message}`);
          });
        }
        return { jobId: '', movieId: existingMovie.id, status: 'cached_from_disk', streamOnly: false };
      }
    }
  }

  // Single-download mode: a new request cancels all previous downloads.
  cancelAllPreviousDownloads();

  // Check concurrent download limit
  const activeCount = Array.from(activeJobs.values())
    .filter(j => j.status === 'downloading').length;

  if (activeCount >= config.maxConcurrentDownloads) {
    // Queue it
    downloadQueue.push({ magnetUri, infoHash: hash, title, source, sizeBytes: sizeBytes || 0, seeders: seeders || 0, leechers: leechers || 0 });
    logger.info(`Download queued (position ${downloadQueue.length}): ${title}`);

    // Create a placeholder movie entry if needed
    let movieId: string;
    if (!existingMovie) {
      movieId = insertMovie({
        info_hash: hash,
        title: title,
        original_torrent_title: title,
        quality: extractQualityTag(title),
        seeders: seeders ?? undefined,
        leechers: leechers ?? undefined,
        size_bytes: sizeBytes ?? undefined,
        status: 'downloading',
        torrent_source: source
      });
    } else {
      movieId = existingMovie.id;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateMovie(movieId, { status: 'downloading' } as any);
    }

    return { jobId: 'queued', movieId, status: 'queued', streamOnly: streamOnly ?? false };
  }

  // Start download immediately
  return startDownload(magnetUri, hash, title, source, sizeBytes, seeders, leechers, streamOnly);
}

function cancelAllPreviousDownloads(): void {
  // Clear queued downloads first and mark their DB rows as cancelled/error.
  while (downloadQueue.length > 0) {
    const queued = downloadQueue.shift();
    if (!queued) continue;
    const queuedMovie = getMovieByInfoHash(queued.infoHash);
    if (queuedMovie && queuedMovie.status !== 'ready') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateMovie(queuedMovie.id, { status: 'error' } as any);
    }
  }

  // Cancel active jobs/torrents.
  for (const [jobId, job] of activeJobs) {
    try {
      if (job.torrent) {
        client.remove(job.torrent);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed removing previous torrent ${job.infoHash}: ${errMsg}`);
    }

    job.status = 'error';
    job.error = 'Cancelled by newer download request';
    job.downloadSpeed = 0;
    emitProgress(job);

    const movie = getMovieByInfoHash(job.infoHash);
    if (movie && movie.status !== 'ready') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateMovie(movie.id, { status: 'error' } as any);
    }

    activeJobs.delete(jobId);
  }
}

/**
 * Start downloading a torrent
 */
async function startDownload(
  magnetUri: string,
  infoHash: string,
  title: string,
  source: string,
  sizeBytes?: number,
  seeders?: number,
  leechers?: number,
  streamOnly?: boolean
): Promise<{ jobId: string; movieId: string; status: string; streamOnly?: boolean }> {
  const hash = infoHash.toLowerCase();
  // stream-only sessions use a temp directory so files are not kept permanently
  const savePath = streamOnly
    ? path.join(os.tmpdir(), 'torstream-temp', hash)
    : getHashDir(hash);

  // Create directory
  if (!fs.existsSync(savePath)) {
    fs.mkdirSync(savePath, { recursive: true });
  }

  // Create or get movie entry
  let movieId: string;
  const existingMovie = getMovieByInfoHash(hash);
  if (!existingMovie) {
    movieId = insertMovie({
      info_hash: hash,
      title: title,
      original_torrent_title: title,
      quality: extractQualityTag(title),
      seeders: seeders ?? undefined,
      leechers: leechers ?? undefined,
      size_bytes: sizeBytes ?? undefined,
      status: 'downloading',
      torrent_source: streamOnly ? 'stream-only' : source
    });
  } else {
    movieId = existingMovie.id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMovie(movieId, { status: 'downloading' } as any);
  }

  // Log the download start
  const logId = insertDownloadLog({
    info_hash: hash,
    torrent_title: title,
    status: 'downloading',
    started_at: new Date().toISOString(),
    file_size: sizeBytes ?? undefined
  });

  // Create download job
  const jobId = uuidv4();
  const job: DownloadJob = {
    id: jobId,
    infoHash: hash,
    torrent: null,
    status: 'downloading',
    progress: 0,
    downloadSpeed: 0,
    numPeers: 0,
    files: [],
    savePath: savePath,
    hlsPath: null,
    error: null,
    startedAt: new Date(),
    completedAt: null
  };
  activeJobs.set(jobId, job);

  logger.info(`Starting download: ${title} (${hash})`);

  try {
    const torrent = client.add(magnetUri, {
      path: savePath,
      announce: [
        'udp://tracker.opentrackr.org:1337/announce',
        'udp://tracker.openbittorrent.com:6969/announce',
        'udp://open.stealth.si:80/announce',
        'udp://tracker.torrent.eu.org:451/announce',
        'udp://exodus.desync.com:6969/announce',
        'udp://tracker.tiny-vps.com:6969/announce',
        'udp://p4p.arenabg.com:1337/announce',
        'udp://tracker.moeking.me:6969/announce'
      ]
    });

    job.torrent = torrent;

    torrent.on('metadata', () => {
      logger.info(`Got metadata for ${hash}, ${torrent.files.length} files`);

      // Select only the largest video file
      const videoFiles = torrent.files
        .filter((f: { name: string }) => isVideoFile(f.name))
        .filter((f: { name: string }) => !isSampleFile(f.name))
        .filter((f: { length: number }) => f.length >= 200 * 1024 * 1024)
        .sort((a: { length: number }, b: { length: number }) => b.length - a.length);

      if (videoFiles.length === 0) {
        // Try including samples if no other video found
        const anyVideo = torrent.files
          .filter((f: { name: string }) => isVideoFile(f.name))
          .sort((a: { length: number }, b: { length: number }) => b.length - a.length);

        if (anyVideo.length === 0) {
          job.status = 'error';
          job.error = 'No video files found in torrent';
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          updateMovie(movieId, { status: 'error' } as any);
          updateDownloadLog(logId, 'error', job.error);
          emitProgress(job);
          return;
        }

        // Select only the largest
        anyVideo.slice(1).forEach((f: { deselect: () => void }) => f.deselect());
      } else {
        // Deselect all non-video and smaller video files
        torrent.files.forEach((f: { deselect: () => void }) => {
          if (!videoFiles.includes(f)) {
            f.deselect();
          }
        });
        // Only keep the largest
        if (videoFiles.length > 1) {
          videoFiles.slice(1).forEach((f: { deselect: () => void }) => f.deselect());
        }
      }

      const selectedFile = videoFiles[0] || torrent.files.find((f: { name: string }) => isVideoFile(f.name));
      if (selectedFile) {
        logger.info(`Selected file: ${selectedFile.name} (${formatBytes(selectedFile.length)})`);
      }
    });

    // Progress reporting
    const progressInterval = setInterval(() => {
      if (job.status !== 'downloading') {
        clearInterval(progressInterval);
        return;
      }

      try {
        job.progress = Math.round(torrent.progress * 100);
        job.downloadSpeed = torrent.downloadSpeed;
        job.numPeers = torrent.numPeers;
        emitProgress(job);
      } catch {
        clearInterval(progressInterval);
      }
    }, 2000);

    // Download timeout
    const timeoutMs = config.downloadTimeoutMinutes * 60 * 1000;
    const timeoutHandle = setTimeout(() => {
      if (job.status === 'downloading') {
        logger.warn(`Download timeout for ${hash}`);
        job.status = 'error';
        job.error = 'Download timed out';
        try { client.remove(torrent); } catch { /* ignore */ }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        updateMovie(movieId, { status: 'error' } as any);
        updateDownloadLog(logId, 'error', 'Download timed out');
        clearInterval(progressInterval);
        emitProgress(job);
        processQueue();
      }
    }, timeoutMs);

    torrent.on('done', async () => {
      clearTimeout(timeoutHandle);
      clearInterval(progressInterval);

      logger.info(`Download complete: ${title} (${hash})`);

      job.progress = 100;
      job.status = 'converting';
      job.downloadSpeed = 0;
      job.completedAt = new Date();
      emitProgress(job);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateMovie(movieId, { status: 'converting', downloaded_at: new Date().toISOString() } as any);
      updateDownloadLog(logId, 'converting');

      // Find the downloaded video file
      const videoPath = findVideoFile(savePath);
      if (!videoPath) {
        job.status = 'error';
        job.error = 'Downloaded file not found on disk';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        updateMovie(movieId, { status: 'error' } as any);
        updateDownloadLog(logId, 'error', job.error);
        emitProgress(job);
        processQueue();
        return;
      }

      // Update video path in DB
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateMovie(movieId, { video_path: videoPath } as any);

      // Start HLS conversion (skip for stream-only sessions)
      if (!streamOnly) {
        try {
          await convertToHls(movieId, hash, videoPath);
          job.status = 'ready';
          job.hlsPath = getHlsDir(hash);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          updateMovie(movieId, { status: 'ready', hls_path: path.join(getHlsDir(hash), 'master.m3u8') } as any);
          updateDownloadLog(logId, 'ready', undefined, new Date().toISOString());
          emitProgress(job);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.warn(`HLS conversion failed (${errMsg}), falling back to direct streaming`);
          job.status = 'ready';
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          updateMovie(movieId, { status: 'ready', video_path: videoPath } as any);
          updateDownloadLog(logId, 'ready', undefined, new Date().toISOString());
          emitProgress(job);
        }
      } else {
        // stream-only: mark ready for direct streaming, no HLS
        job.status = 'ready';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        updateMovie(movieId, { status: 'ready', video_path: videoPath } as any);
        updateDownloadLog(logId, 'ready', undefined, new Date().toISOString());
        emitProgress(job);
      }

      // Stop seeding if configured
      if (!config.seedAfterDownload) {
        try { client.remove(torrent); } catch { /* ignore */ }
      }

      processQueue();
    });

    torrent.on('error', (err: Error) => {
      clearTimeout(timeoutHandle);
      clearInterval(progressInterval);
      job.status = 'error';
      job.error = err.message;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateMovie(movieId, { status: 'error' } as any);
      updateDownloadLog(logId, 'error', err.message);
      emitProgress(job);
      processQueue();
    });

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    job.status = 'error';
    job.error = `Failed to start download: ${errMsg}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMovie(movieId, { status: 'error' } as any);
    updateDownloadLog(logId, 'error', job.error);
    emitProgress(job);
  }

  return { jobId, movieId, status: 'downloading', streamOnly: streamOnly ?? false };
}

/**
 * Clean up a stream-only session: remove the torrent, delete temp files, and purge the DB entry.
 */
export function cleanupStreamOnlySession(movieId: string, infoHash: string): void {
  const hash = infoHash.toLowerCase();

  // Remove the active WebTorrent torrent
  for (const [jobId, job] of activeJobs.entries()) {
    if (job.infoHash === hash) {
      try {
        if (job.torrent) client.remove(job.torrent);
      } catch { /* ignore */ }
      activeJobs.delete(jobId);
      break;
    }
  }

  // Delete temp directory
  const tempDir = path.join(os.tmpdir(), 'torstream-temp', hash);
  if (fs.existsSync(tempDir)) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (err) {
      logger.warn(`Could not delete stream-only temp dir: ${(err as Error).message}`);
    }
  }

  // Remove from database
  try { deleteMovie(movieId); } catch (err) {
    logger.warn(`Could not delete stream-only movie from DB: ${(err as Error).message}`);
  }

  logger.info(`Stream-only session cleaned up: ${hash}`);
}

/**
 * Process the download queue
 */
async function processQueue(): Promise<void> {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  try {
    while (downloadQueue.length > 0) {
      const activeCount = Array.from(activeJobs.values())
        .filter(j => j.status === 'downloading').length;

      if (activeCount >= config.maxConcurrentDownloads) break;

      const item = downloadQueue.shift();
      if (item) {
        await startDownload(
          item.magnetUri,
          item.infoHash,
          item.title,
          item.source,
          item.sizeBytes,
          item.seeders,
          item.leechers
        );
      }
    }
  } finally {
    isProcessingQueue = false;
  }
}

/**
 * Get all active download jobs
 */
export function getActiveJobs(): DownloadJob[] {
  return Array.from(activeJobs.values());
}

/**
 * Get a specific download job
 */
export function getJob(id: string): DownloadJob | undefined {
  return activeJobs.get(id);
}

/**
 * Cancel a download job
 */
export function cancelDownload(jobId: string): boolean {
  const job = activeJobs.get(jobId);
  if (!job) return false;

  try {
    if (job.torrent) {
      client.remove(job.torrent);
    }
    job.status = 'error';
    job.error = 'Cancelled by admin';
    emitProgress(job);
    activeJobs.delete(jobId);
    processQueue();
    return true;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Error cancelling download ${jobId}: ${errMsg}`);
    return false;
  }
}

/**
 * Restore downloads from disk on server startup
 */
export function restoreDownloadsFromDisk(): void {
  const cacheDir = config.cacheDir;
  if (!fs.existsSync(cacheDir)) return;

  const entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const hash = entry.name.toLowerCase();

    // Check if this looks like an infoHash (40 hex chars)
    if (!/^[a-f0-9]{40}$/.test(hash)) continue;

    const hashDir = path.join(cacheDir, hash);
    const hlsDir = path.join(hashDir, 'hls');
    const videoPath = findVideoFile(hashDir);

    if (videoPath) {
      const hasHls = fs.existsSync(path.join(hlsDir, 'master.m3u8'));

      if (!hasHls) {
        const existing = getMovieByInfoHash(hash);

        if (existing) {
          // Mark ready for direct streaming; try HLS in background if ffmpeg available
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          updateMovie(existing.id, { status: 'ready', video_path: videoPath } as any);
          logger.info(`Found cached video without HLS for ${hash}, marking ready for direct streaming`);
          convertToHls(existing.id, hash, videoPath).catch((err: Error) => {
            logger.warn(`HLS conversion skipped for ${hash} (no ffmpeg): ${err.message}`);
          });
        }
      } else if (!getMovieByInfoHash(hash)) {
        // Has everything but not in DB — add it
        logger.info(`Found uncached movie on disk: ${hash}`);
        const posterPath = path.join(hlsDir, 'poster.jpg');
        insertMovie({
          info_hash: hash,
          title: path.basename(videoPath, path.extname(videoPath)),
          quality: extractQualityTag(path.basename(videoPath)),
          hls_path: path.join(hlsDir, 'master.m3u8'),
          video_path: videoPath,
          status: 'ready',
          local_poster: fs.existsSync(posterPath) ? posterPath : undefined
        });
      }
    }
  }
}

/**
 * Destroy the WebTorrent client and stop all downloads
 */
export function destroyDownloader(): Promise<void> {
  return new Promise((resolve) => {
    if (client) {
      client.destroy((err: Error | undefined) => {
        if (err) {
          logger.error(`Error destroying WebTorrent client: ${err.message}`);
        }
        resolve();
      });
    } else {
      resolve();
    }
  });
}

// ============================================================
// Helper functions
// ============================================================

type TorrentFile = { name: string; length: number; createReadStream: (opts?: { start?: number; end?: number }) => NodeJS.ReadableStream };

function pickVideoFile(files: TorrentFile[]): TorrentFile | null {
  const videoExts = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm'];
  const videoFiles = files
    .filter(f => videoExts.includes(path.extname(f.name).toLowerCase()))
    .sort((a, b) => b.length - a.length);
  return videoFiles[0] || null;
}

/**
 * Get the active WebTorrent file object for a given infoHash (while downloading).
 * Returns null if the torrent is not currently active or metadata not yet received.
 */
export function getActiveTorrentFile(infoHash: string): TorrentFile | null {
  const hash = infoHash.toLowerCase();
  for (const job of activeJobs.values()) {
    if (job.infoHash !== hash) continue;
    if (!job.torrent) continue;
    const t = job.torrent as { files: TorrentFile[] };
    const files: TorrentFile[] = t.files;
    if (!files || files.length === 0) return null;
    return pickVideoFile(files);
  }
  return null;
}

/**
 * Wait for torrent metadata and return the video file.
 * Resolves immediately if files are already available, otherwise waits up to timeoutMs.
 * Returns null if torrent is not active or times out.
 */
export function waitForTorrentFile(infoHash: string, timeoutMs = 45000): Promise<TorrentFile | null> {
  const hash = infoHash.toLowerCase();

  // Check if already available
  const immediate = getActiveTorrentFile(hash);
  if (immediate) return Promise.resolve(immediate);

  // Find the job's torrent object (may not have metadata yet)
  let torrent: { files: TorrentFile[]; on: (event: string, cb: () => void) => void } | null = null;
  for (const job of activeJobs.values()) {
    if (job.infoHash === hash && job.torrent) {
      torrent = job.torrent as { files: TorrentFile[]; on: (event: string, cb: () => void) => void };
      break;
    }
  }

  if (!torrent) return Promise.resolve(null);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, timeoutMs);

    torrent!.on('metadata', () => {
      clearTimeout(timer);
      const files: TorrentFile[] = torrent!.files;
      resolve(pickVideoFile(files));
    });
  });
}

function emitProgress(job: DownloadJob): void {
  if (!io) return;
  io.emit('download-progress', {
    type: 'download-progress',
    data: {
      id: job.id,
      infoHash: job.infoHash,
      progress: job.progress,
      downloadSpeed: job.downloadSpeed,
      numPeers: job.numPeers,
      status: job.status
    }
  });
}

function isVideoFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm'].includes(ext);
}

function isSampleFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('sample') || lower.includes('trailer') || lower.includes('preview');
}

function findVideoFile(dir: string): string | null {
  const hlsDirPath = path.join(dir, 'hls');

  const searchForVideo = (searchDir: string): string | null => {
    try {
      const entries = fs.readdirSync(searchDir, { withFileTypes: true });

      // Collect all video files
      const videoFiles: Array<{ name: string; filePath: string; size: number }> = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Skip HLS directory
          const fullPath = path.join(searchDir, entry.name);
          if (fullPath === hlsDirPath) continue;
          const subResult = searchForVideo(fullPath);
          if (subResult !== null) {
            videoFiles.push({
              name: path.basename(subResult),
              filePath: subResult,
              size: fs.statSync(subResult).size
            });
          }
        } else if (isVideoFile(entry.name)) {
          const fullPath = path.join(searchDir, entry.name);
          const stat = fs.statSync(fullPath);
          if (stat.size >= 200 * 1024 * 1024) { // 200MB minimum
            videoFiles.push({ name: entry.name, filePath: fullPath, size: stat.size });
          }
        }
      }

      // Sort by size, return largest
      videoFiles.sort((a, b) => b.size - a.size);

      // Filter out sample/trailer files if possible
      const nonSample = videoFiles.filter(f => !isSampleFile(f.name));
      if (nonSample.length > 0) return nonSample[0].filePath;
      if (videoFiles.length > 0) return videoFiles[0].filePath;

      return null;
    } catch {
      return null;
    }
  };

  return searchForVideo(dir);
}

function extractQualityTag(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes('2160p') || lower.includes('4k') || lower.includes('uhd')) return '4K';
  if (lower.includes('1080p')) return '1080p';
  if (lower.includes('720p')) return '720p';
  if (lower.includes('480p')) return '480p';
  const camKw = ['cam', 'hdcam', 'tsrip', 'pdvd', 'predvd', 'camrip'];
  if (camKw.some(kw => lower.includes(kw))) return 'CAM';
  return 'Unknown';
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
