import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { authMiddleware } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import {
  listMovies, getMovieById, deleteMovie, deleteAllMovies, updateMovie,
  getDb, getReadyMoviesCount, getErrorMoviesCount, getDownloadingMoviesCount,
  createAdminSession
} from '../services/database.js';
import { searchTorrents, resolveMagnetUri } from '../services/search.js';
import { fetchMetadata } from '../services/metadata.js';
import { queueDownload, getActiveJobs, cancelDownload } from '../services/downloader.js';
import { reconvertToHls } from '../services/hls-converter.js';
import {
  getDiskSpace, getCacheSize, getPerMovieDiskUsage, checkDiskSpace,
  deleteMovieFiles, deleteAllCacheFiles, cleanupOrphanedFiles
} from '../services/cache.js';
import {
  validateLoginBody, validateDownloadBody, validateBatchDownloadBody,
  validateSearchAndCacheBody, validateUuid
} from '../utils/validators.js';
import { extractQuality } from '../utils/helpers.js';
import logger from '../utils/logger.js';
import config from '../config.js';

const router = Router();

// ============================================================
// POST /api/admin/login
// ============================================================
router.post('/login', (req: Request, res: Response) => {
  try {
    const { username, password } = validateLoginBody(req.body);

    if (username !== config.adminUsername || password !== config.adminPassword) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const token = jwt.sign(
      { username, isAdmin: true },
      config.jwtSecret,
      { expiresIn: '24h' }
    );

    // Store session
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    createAdminSession(token, expiresAt);

    res.json({ token, expiresIn: '24h' });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ============================================================
// All routes below require authentication
// ============================================================
router.use(authMiddleware);

// ============================================================
// GET /api/admin/dashboard
// ============================================================
router.get('/dashboard', (_req: Request, res: Response) => {
  try {
    const disk = getDiskSpace();
    const cacheSize = getCacheSize();
    const totalMovies = getReadyMoviesCount();
    const failedJobs = getErrorMoviesCount();
    const activeDownloads = getDownloadingMoviesCount();

    res.json({
      totalMovies,
      cacheSizeBytes: cacheSize,
      diskFreeBytes: disk.free,
      diskTotalBytes: disk.total,
      activeDownloads,
      failedJobs
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ============================================================
// GET /api/admin/movies — ALL movies including non-ready
// ============================================================
router.get('/movies', (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const status = req.query.status as string | undefined;

    const result = listMovies({ page, limit, status });

    // Include file paths for admin but sanitize
    const sanitizedData = result.data.map(movie => ({
      ...movie,
      hls_path: movie.hls_path ? `/stream/${movie.id}/master.m3u8` : null,
      local_poster: movie.local_poster ? `/api/poster/${movie.id}` : null
    }));

    res.json({
      data: sanitizedData,
      pagination: result.pagination
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ============================================================
// GET /api/admin/downloads — Active download jobs
// ============================================================
router.get('/downloads', (_req: Request, res: Response) => {
  try {
    const jobs = getActiveJobs().map(job => ({
      id: job.id,
      infoHash: job.infoHash,
      status: job.status,
      progress: job.progress,
      downloadSpeed: job.downloadSpeed,
      numPeers: job.numPeers,
      error: job.error,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      savePath: job.savePath,
      hlsPath: job.hlsPath
    }));
    res.json({ downloads: jobs });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ============================================================
// POST /api/admin/download — Manually trigger a download
// ============================================================
router.post('/download', async (req: Request, res: Response) => {
  try {
    const { magnetUri, infoHash } = validateDownloadBody(req.body);

    // Check disk space
    const diskCheck = checkDiskSpace(5 * 1024 ** 3); // Assume 5GB minimum
    if (!diskCheck.ok) {
      res.status(507).json({ error: diskCheck.message });
      return;
    }

    const title = (req.body.title as string) || infoHash;
    const source = (req.body.source as string) || 'admin-manual';
    const sizeBytes = req.body.sizeBytes as number | undefined;
    const seeders = req.body.seeders as number | undefined;
    const leechers = req.body.leechers as number | undefined;

    // Fetch metadata in background
    const metadata = await fetchMetadata(title);

    const result = await queueDownload({
      magnetUri,
      infoHash,
      title: metadata?.title || title,
      source,
      sizeBytes,
      seeders,
      leechers
    });

    // If we got metadata, update the movie entry
    if (metadata && result.movieId) {
      updateMovie(result.movieId, {
        title: metadata.title,
        year: metadata.year,
        genre: metadata.genre,
        plot: metadata.plot,
        poster: metadata.poster,
        imdb_id: metadata.imdbID,
        imdb_rating: metadata.imdbRating,
        quality: metadata.quality
      } as any);
    }

    res.json({
      message: 'Download initiated',
      movieId: result.movieId,
      jobId: result.jobId,
      status: result.status
    });
  } catch (err) {
    logger.error(`Admin download error: ${(err as Error).message}`);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ============================================================
// POST /api/admin/download/batch — Queue multiple downloads
// ============================================================
router.post('/download/batch', async (req: Request, res: Response) => {
  try {
    const items = validateBatchDownloadBody(req.body);

    const results = [];
    for (const item of items) {
      try {
        const result = await queueDownload({
          magnetUri: item.magnetUri,
          infoHash: item.infoHash,
          title: item.infoHash, // Title might be provided separately
          source: 'admin-batch'
        });
        results.push({ infoHash: item.infoHash, ...result });
      } catch (err) {
        results.push({ infoHash: item.infoHash, error: (err as Error).message });
      }
    }

    res.json({ message: `Queued ${results.length} downloads`, results });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ============================================================
// DELETE /api/admin/movies/:id — Delete one cached movie
// ============================================================
router.delete('/movies/:id', (req: Request, res: Response) => {
  try {
    const id = validateUuid(req.params.id);
    const movie = getMovieById(id);
    if (!movie) {
      res.status(404).json({ error: 'Movie not found' });
      return;
    }

    deleteMovieFiles(movie.info_hash);
    deleteMovie(id);

    res.json({ message: 'Movie deleted', id });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ============================================================
// DELETE /api/admin/movies — Delete ALL cached movies
// ============================================================
router.delete('/movies', (req: Request, res: Response) => {
  try {
    const confirm = req.body.confirm;
    if (confirm !== 'DELETE_ALL') {
      res.status(400).json({ error: 'Confirmation required. Send { confirm: "DELETE_ALL" }' });
      return;
    }

    const count = deleteAllMovies();
    deleteAllCacheFiles();

    res.json({ message: `Deleted ${count} movies` });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ============================================================
// POST /api/admin/movies/:id/reconvert — Re-run HLS conversion
// ============================================================
router.post('/movies/:id/reconvert', async (req: Request, res: Response) => {
  try {
    const id = validateUuid(req.params.id);
    const movie = getMovieById(id);
    if (!movie) {
      res.status(404).json({ error: 'Movie not found' });
      return;
    }

    if (!movie.video_path) {
      res.status(400).json({ error: 'No video file found for this movie' });
      return;
    }

    if (!fs.existsSync(movie.video_path)) {
      res.status(400).json({ error: 'Video file not found on disk' });
      return;
    }

    // Run conversion in background
    reconvertToHls(id, movie.info_hash, movie.video_path)
      .then(() => {
        updateMovie(id, { status: 'ready', hls_path: path.join(path.dirname(movie.video_path!), 'hls', 'master.m3u8') } as any);
        logger.info(`Re-conversion complete for ${id}`);
      })
      .catch(err => {
        updateMovie(id, { status: 'error' } as any);
        logger.error(`Re-conversion failed for ${id}: ${err.message}`);
      });

    res.json({ message: 'Re-conversion started', id });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ============================================================
// POST /api/admin/search-and-cache — Search and auto-download
// ============================================================
router.post('/search-and-cache', async (req: Request, res: Response) => {
  try {
    const { query, maxResults } = validateSearchAndCacheBody(req.body);

    const searchResults = await searchTorrents(query);

    // Take top N results
    const topResults = searchResults.slice(0, maxResults);

    const results = [];
    for (const result of topResults) {
      try {
        // Fetch metadata
        const metadata = await fetchMetadata(result.title);

        // Check disk space
        const diskCheck = checkDiskSpace(result.sizeBytes || 5 * 1024 ** 3);
        if (!diskCheck.ok) {
          results.push({ title: result.title, error: diskCheck.message });
          continue;
        }

        const downloadResult = await queueDownload({
          magnetUri: result.magnetUri,
          infoHash: result.infoHash,
          title: metadata?.title || result.title,
          source: result.source,
          sizeBytes: result.sizeBytes,
          seeders: result.seeders,
          leechers: result.leechers
        });

        // Update with metadata if available
        if (metadata && downloadResult.movieId) {
          updateMovie(downloadResult.movieId, {
            title: metadata.title,
            year: metadata.year,
            genre: metadata.genre,
            plot: metadata.plot,
            poster: metadata.poster,
            imdb_id: metadata.imdbID,
            imdb_rating: metadata.imdbRating,
            quality: metadata.quality
          } as any);
        }

        results.push({
          title: metadata?.title || result.title,
          movieId: downloadResult.movieId,
          status: downloadResult.status
        });
      } catch (err) {
        results.push({ title: result.title, error: (err as Error).message });
      }
    }

    res.json({ query, totalFound: searchResults.length, queued: results.length, results });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ============================================================
// GET /api/admin/disk — Disk usage details
// ============================================================
router.get('/disk', (_req: Request, res: Response) => {
  try {
    const disk = getDiskSpace();
    const cacheSize = getCacheSize();
    const perMovie = getPerMovieDiskUsage();

    res.json({
      total: disk.total,
      used: disk.used,
      free: disk.free,
      cacheSize,
      perMovie
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ============================================================
// POST /api/admin/cleanup — Remove error movies and orphans
// ============================================================
router.post('/cleanup', (_req: Request, res: Response) => {
  try {
    const result = cleanupOrphanedFiles();
    res.json({ message: 'Cleanup complete', ...result });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ============================================================
// POST /api/admin/downloads/:id/cancel — Cancel a download
// ============================================================
router.post('/downloads/:id/cancel', (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const success = cancelDownload(id);
    if (success) {
      res.json({ message: 'Download cancelled', id });
    } else {
      res.status(404).json({ error: 'Download job not found' });
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
