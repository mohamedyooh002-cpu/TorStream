import { Router, Request, Response } from 'express';
import {
  listMovies, getMovieById, getDistinctGenres, getDistinctQualities,
  getPublicStats, getMovieByInfoHash,
  recordMoviePlay, listTrendingMovies, listRecentlyAddedMovies, listNewlyAddedMovies
} from '../services/database.js';
import { searchTorrents, resolveMagnetUri } from '../services/search.js';
import { fetchMetadata } from '../services/metadata.js';
import { queueDownload, cleanupStreamOnlySession } from '../services/downloader.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validatePagination, validateSort, sanitizeHtml } from '../utils/validators.js';
import { extractQuality } from '../utils/helpers.js';
import { EnrichedSearchResult } from '../types/index.js';
import logger from '../utils/logger.js';
import config from '../config.js';

const router = Router();

// ============================================================
// GET /api/movies — List all cached/ready movies
// ============================================================
router.get('/movies', (req: Request, res: Response) => {
  try {
    const { page, limit } = validatePagination(req.query.page, req.query.limit);
    const sort = validateSort(req.query.sort as string, ['seeders', 'imdb_rating', 'year', 'added_at', 'title', 'size_bytes'], 'added_at');
    const genre = req.query.genre as string | undefined;
    const quality = req.query.quality as string | undefined;
    const search = req.query.search as string | undefined;
    const statusQuery = req.query.status as string | undefined;
    const allowedStatus = ['ready', 'downloading', 'converting', 'error'];
    const status = statusQuery && allowedStatus.includes(statusQuery) ? statusQuery : undefined;

    const result = listMovies({ sort, genre, quality, search, page, limit, status });

    // Sanitize output — remove absolute paths
    const sanitizedData = result.data.map(movie => ({
      ...movie,
      _id: movie.id,
      video_path: undefined,
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
// GET /api/movies/:id — Single movie details
// ============================================================
router.get('/movies/:id', (req: Request, res: Response) => {
  try {
    const movie = getMovieById(req.params.id);
    if (!movie) {
      res.status(404).json({ error: 'Movie not found' });
      return;
    }

    res.json({
      ...movie,
      _id: movie.id,
      hls_path: movie.hls_path ? `/stream/${movie.id}/master.m3u8` : null,
      local_poster: movie.local_poster ? `/api/poster/${movie.id}` : null,
      video_path: undefined // Never expose absolute paths
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ============================================================
// POST /api/movies/:id/play — Record a play event
// ============================================================
router.post('/movies/:id/play', rateLimit(30, 60000), (req: Request, res: Response) => {
  try {
    const movie = getMovieById(req.params.id);
    if (!movie) {
      res.status(404).json({ error: 'Movie not found' });
      return;
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = String(req.headers['user-agent'] || '');
    const recorded = recordMoviePlay(movie.id, ip, userAgent);

    res.json({ success: true, recorded });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ============================================================
// GET /api/home — Homepage feed (trending/recent/newly-added)
// ============================================================
router.get('/home', (req: Request, res: Response) => {
  try {
    const rawLimit = Number(req.query.limit || 20);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 20;

    const trending = listTrendingMovies(limit);
    const trendingIds = new Set(trending.map(m => m.id));

    const recentlyAdded = listRecentlyAddedMovies(limit, Array.from(trendingIds));
    const recentIds = new Set(recentlyAdded.map(m => m.id));

    const excludedForNew = Array.from(new Set([...Array.from(trendingIds), ...Array.from(recentIds)]));
    const newlyAdded = listNewlyAddedMovies(limit, excludedForNew);

    const sanitize = (movie: ReturnType<typeof getMovieById> | null) => {
      if (!movie) return null;
      return {
        ...movie,
        _id: movie.id,
        video_path: undefined,
        hls_path: movie.hls_path ? `/stream/${movie.id}/master.m3u8` : null,
        local_poster: movie.local_poster ? `/api/poster/${movie.id}` : null
      };
    };

    const cleanedTrending = trending.map(m => sanitize(m)).filter(Boolean);
    const cleanedRecent = recentlyAdded.map(m => sanitize(m)).filter(Boolean);
    const cleanedNew = newlyAdded.map(m => sanitize(m)).filter(Boolean);

    res.json({
      trending: cleanedTrending,
      recentlyAdded: cleanedRecent,
      newlyAdded: cleanedNew
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ============================================================
// GET /api/genres — List all distinct genres
// ============================================================
router.get('/genres', (_req: Request, res: Response) => {
  try {
    const genres = getDistinctGenres();
    res.json({ genres });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ============================================================
// GET /api/qualities — List all distinct quality tags
// ============================================================
router.get('/qualities', (_req: Request, res: Response) => {
  try {
    const qualities = getDistinctQualities();
    res.json({ qualities });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ============================================================
// GET /api/stats — Public stats
// ============================================================
router.get('/stats', (_req: Request, res: Response) => {
  try {
    const stats = getPublicStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ============================================================
// GET /api/poster/:id — Serve poster image
// ============================================================
router.get('/poster/:id', (req: Request, res: Response) => {
  try {
    const movie = getMovieById(req.params.id);
    if (!movie) {
      res.status(404).json({ error: 'Movie not found' });
      return;
    }

    // Try local poster first
    if (movie.local_poster) {
      const fs = require('fs');
      const path = require('path');
      if (fs.existsSync(movie.local_poster)) {
        res.sendFile(path.resolve(movie.local_poster));
        return;
      }
    }

    // Fallback to OMDb poster URL
    if (movie.poster && movie.poster !== 'N/A') {
      res.redirect(movie.poster);
      return;
    }

    res.status(404).json({ error: 'No poster available' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ============================================================
// GET /api/search?q=...&page=1 — Search external torrent APIs
// ============================================================
router.get('/search', rateLimit(config.searchRateLimitPerMin, 60000), async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string;
    if (!query || query.trim().length < 2) {
      res.status(400).json({ error: 'Search query must be at least 2 characters' });
      return;
    }

    const results = await searchTorrents(query.trim());

    // Enrich with metadata and check if already cached
    const enriched: EnrichedSearchResult[] = [];

    // Process results in batches to avoid OMDb rate limits
    for (const result of results.slice(0, 30)) {
      // Check if already cached in our DB
      const existing = getMovieByInfoHash(result.infoHash);
      const qualityInfo = extractQuality(result.title);

      // Fetch OMDb metadata (with caching, so this is efficient)
      let metadata = null;
      try {
        metadata = await fetchMetadata(result.title);
      } catch {
        // Non-fatal — continue without metadata
      }

      enriched.push({
        ...result,
        metadata,
        cached: !!existing,
        movieId: existing ? existing.id : null,
        status: existing ? existing.status : null,
        quality: qualityInfo.quality
      });
    }

    res.json({
      query: query.trim(),
      totalResults: enriched.length,
      results: enriched
    });
  } catch (err) {
    logger.error(`Search API error: ${(err as Error).message}`);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ============================================================
// POST /api/request-download — Public download request (rate-limited)
// ============================================================
router.post('/request-download', rateLimit(config.downloadRequestRateLimitPerHour, 3600000), async (req: Request, res: Response) => {
  try {
    const { magnetUri, infoHash, title, source, streamOnly } = req.body;

    if (!magnetUri || !infoHash) {
      res.status(400).json({ error: 'magnetUri and infoHash are required' });
      return;
    }

    if (!magnetUri.startsWith('magnet:?')) {
      res.status(400).json({ error: 'Invalid magnet URI' });
      return;
    }

    const hash = (infoHash as string).toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(hash)) {
      res.status(400).json({ error: 'Invalid info hash' });
      return;
    }

    const result = await queueDownload({
      magnetUri,
      infoHash: hash,
      title: title || 'Unknown',
      source: source || 'public-request',
      streamOnly: streamOnly === true
    });

    res.json({
      message: 'Download queued',
      movieId: result.movieId,
      status: result.status,
      streamOnly: result.streamOnly ?? false
    });
  } catch (err) {
    logger.error(`Download request error: ${(err as Error).message}`);
    res.status(500).json({ error: 'Failed to queue download' });
  }
});

// ============================================================
// DELETE /api/movies/:id/stream-cleanup — Clean up a stream-only session
// ============================================================
router.delete('/movies/:id/stream-cleanup', async (req: Request, res: Response) => {
  try {
    const movie = getMovieById(req.params.id);
    if (!movie) {
      res.status(404).json({ error: 'Movie not found' });
      return;
    }
    // Only allow cleanup of stream-only sessions
    if (movie.torrent_source !== 'stream-only') {
      res.status(400).json({ error: 'Not a stream-only session' });
      return;
    }
    cleanupStreamOnlySession(movie.id, movie.info_hash);
    res.json({ message: 'Stream-only session cleaned up' });
  } catch (err) {
    logger.error(`Stream cleanup error: ${(err as Error).message}`);
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

export default router;
