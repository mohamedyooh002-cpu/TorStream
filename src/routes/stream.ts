import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getMovieById, updateMovie } from '../services/database.js';
import { getHlsDir, getHashDir } from '../utils/helpers.js';
import { getActiveTorrentFile, waitForTorrentFile } from '../services/downloader.js';
import logger from '../utils/logger.js';

const router = Router();

// ============================================================
// GET /stream/:id/direct — Serve raw video with range support
// Uses WebTorrent's createReadStream while downloading (progressive),
// falls back to fs when download is complete.
// ============================================================
router.get('/:id/direct', async (req: Request, res: Response) => {
  try {
    const movie = getMovieById(req.params.id);
    if (!movie) { res.status(404).json({ error: 'Movie not found' }); return; }

    const mimeTypes: Record<string, string> = {
      '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime', '.wmv': 'video/x-ms-wmv', '.m4v': 'video/mp4',
      '.webm': 'video/webm'
    };

    // ── Case 1: torrent is active → stream via WebTorrent ────────────────────
    // Wait up to 45s for metadata if torrent just started
    let torrentFile = getActiveTorrentFile(movie.info_hash);
    if (!torrentFile) {
      torrentFile = await waitForTorrentFile(movie.info_hash, 45000);
    }
    if (torrentFile) {
      const fileSize = torrentFile.length;
      const ext = path.extname(torrentFile.name).toLowerCase();
      const contentType = mimeTypes[ext] || 'video/mp4';

      const rangeHeader = req.headers.range;
      if (rangeHeader) {
        const parts = rangeHeader.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 4 * 1024 * 1024, fileSize - 1);
        const chunkSize = end - start + 1;

        if (start >= fileSize) {
          res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
          return;
        }

        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.setHeader('Content-Length', chunkSize);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Accept-Ranges', 'bytes');
        const stream = torrentFile.createReadStream({ start, end });
        stream.pipe(res);
        req.on('close', () => { try { (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.(); } catch { /* ignore */ } });
      } else {
        res.setHeader('Content-Length', fileSize);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Accept-Ranges', 'bytes');
        torrentFile.createReadStream().pipe(res);
      }
      return;
    }

    // ── Case 2: download complete → stream from disk ──────────────────────────
    let videoPath = movie.video_path || '';
    if (!videoPath || !fs.existsSync(videoPath)) {
      const hashDir = getHashDir(movie.info_hash);
      if (!fs.existsSync(hashDir)) { res.status(404).json({ error: 'No video file on disk yet' }); return; }
      const files = fs.readdirSync(hashDir);
      const videoExts = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.m4v', '.webm'];
      const found = files.find(f => videoExts.includes(path.extname(f).toLowerCase()));
      if (!found) { res.status(404).json({ error: 'No video file on disk yet' }); return; }
      videoPath = path.join(hashDir, found);
    }

    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const ext = path.extname(videoPath).toLowerCase();
    const contentType = mimeTypes[ext] || 'video/mp4';

    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 10 * 1024 * 1024, fileSize - 1);
      const chunkSize = end - start + 1;

      if (start >= fileSize) {
        res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
        return;
      }

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunkSize);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', 'bytes');
      fs.createReadStream(videoPath, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', fileSize);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', 'bytes');
      fs.createReadStream(videoPath).pipe(res);
    }
  } catch (err) {
    logger.error(`Direct stream error: ${(err as Error).message}`);
    res.status(500).json({ error: 'Stream error' });
  }
});

// ============================================================
// GET /stream/:id/master.m3u8 — Serve HLS master playlist
// ============================================================
router.get('/:id/master.m3u8', (req: Request, res: Response) => {
  try {
    const movie = getMovieById(req.params.id);
    if (!movie) {
      res.status(404).json({ error: 'Movie not found' });
      return;
    }

    if (movie.status !== 'ready' || !movie.hls_path) {
      res.status(404).json({ error: 'Movie not ready for streaming' });
      return;
    }

    const m3u8Path = path.resolve(movie.hls_path);
    if (!fs.existsSync(m3u8Path)) {
      res.status(404).json({ error: 'HLS playlist not found on disk' });
      return;
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(m3u8Path);
  } catch (err) {
    logger.error(`Stream serve error: ${(err as Error).message}`);
    res.status(500).json({ error: 'Stream error' });
  }
});

// ============================================================
// GET /stream/:id/segment_:num.ts — Serve HLS segments with range support
// ============================================================
router.get('/:id/segment_:num.ts', (req: Request, res: Response) => {
  try {
    const movie = getMovieById(req.params.id);
    if (!movie) {
      res.status(404).json({ error: 'Movie not found' });
      return;
    }

    if (movie.status !== 'ready') {
      res.status(404).json({ error: 'Movie not ready for streaming' });
      return;
    }

    // Find the segment file in the HLS directory
    const hlsDir = getHlsDir(movie.info_hash);
    const segmentName = `segment_${req.params.num}.ts`;
    const segmentPath = path.join(hlsDir, segmentName);

    if (!fs.existsSync(segmentPath)) {
      res.status(404).json({ error: 'Segment not found' });
      return;
    }

    const stat = fs.statSync(segmentPath);
    const fileSize = stat.size;

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Accept-Ranges', 'bytes');

    // Handle range requests
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      if (start >= fileSize || end >= fileSize) {
        res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
        res.end();
        return;
      }

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunkSize);

      const readStream = fs.createReadStream(segmentPath, { start, end });
      readStream.pipe(res);
    } else {
      res.setHeader('Content-Length', fileSize);
      const readStream = fs.createReadStream(segmentPath);
      readStream.pipe(res);
    }
  } catch (err) {
    logger.error(`Segment serve error: ${(err as Error).message}`);
    res.status(500).json({ error: 'Segment serve error' });
  }
});

// ============================================================
// GET /stream/:id/poster.jpg — Serve poster from HLS dir
// ============================================================
router.get('/:id/poster.jpg', (req: Request, res: Response) => {
  try {
    const movie = getMovieById(req.params.id);
    if (!movie) {
      res.status(404).json({ error: 'Movie not found' });
      return;
    }

    const hlsDir = getHlsDir(movie.info_hash);
    const posterPath = path.join(hlsDir, 'poster.jpg');

    if (!fs.existsSync(posterPath)) {
      res.status(404).json({ error: 'Poster not found' });
      return;
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.sendFile(path.resolve(posterPath));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
