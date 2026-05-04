import express from 'express';
import http from 'http';
import { Server as SocketServer } from 'socket.io';
import helmet from 'helmet';
import cors from 'cors';
import path from 'path';
import fs from 'fs';

import config from './config.js';
import logger from './utils/logger.js';
import { initDatabase, closeDatabase, verifyMoviesOnDisk, cleanupExpiredSessions } from './services/database.js';
import { initDownloader, restoreDownloadsFromDisk, destroyDownloader } from './services/downloader.js';
import { setHlsSocketIo, checkFfmpegAvailability } from './services/hls-converter.js';
import publicRoutes from './routes/public.js';
import adminRoutes from './routes/admin.js';
import streamRoutes from './routes/stream.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';

// ============================================================
// Initialization
// ============================================================

// Ensure required directories exist
const dirs = [config.cacheDir, path.join(process.cwd(), 'logs')];
for (const dir of dirs) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.info(`Created directory: ${dir}`);
  }
}

// Check ffmpeg availability
const ffmpegStatus = checkFfmpegAvailability();
if (!ffmpegStatus.ffmpeg || !ffmpegStatus.ffprobe) {
  logger.error(`CRITICAL: ffmpeg not found! ffmpeg=${ffmpegStatus.ffmpeg}, ffprobe=${ffmpegStatus.ffprobe}. HLS conversion will be disabled.`);
} else {
  logger.info('ffmpeg and ffprobe are available');
}

// Initialize database
const db = initDatabase();

// Verify movies on disk
verifyMoviesOnDisk();

// Cleanup expired sessions periodically
setInterval(() => {
  try {
    cleanupExpiredSessions();
  } catch { /* ignore */ }
}, 3600000); // Every hour

// ============================================================
// Express + Socket.IO setup
// ============================================================

const app = express();
const server = http.createServer(app);

// Socket.IO setup
const io = new SocketServer(server, {
  // Keep default transports so browser polling handshake can succeed before upgrade.
  transports: ['polling', 'websocket'],
  pingInterval: 25000,
  pingTimeout: 5000,
  cors: {
    origin: config.corsOrigin === '*' ? true : config.corsOrigin,
    methods: ['GET', 'POST']
  }
});

io.on('connection', (socket) => {
  logger.debug(`Socket.IO client connected: ${socket.id}`);

  socket.on('disconnect', () => {
    logger.debug(`Socket.IO client disconnected: ${socket.id}`);
  });
});

// ============================================================
// Middleware
// ============================================================

app.use(helmet({
  contentSecurityPolicy: false, // Allow CDN resources
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: config.corsOrigin === '*' ? true : config.corsOrigin,
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(requestLogger);

// ============================================================
// API Routes
// ============================================================

app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);
app.use('/stream', streamRoutes);

// ============================================================
// Static files (frontend)
// ============================================================

const publicDir = path.join(process.cwd(), 'public');
app.use(express.static(publicDir));

// Serve index.html for root
app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Serve admin.html for /admin
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

// SPA fallback for non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/stream/')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Error handler (must be last)
app.use(errorHandler);

// ============================================================
// Initialize services
// ============================================================

initDownloader(io);
setHlsSocketIo(io);

// Restore downloads from disk
restoreDownloadsFromDisk();

// ============================================================
// Start server
// ============================================================

server.listen(config.port, config.host, () => {
  logger.info(`TorrentStream server running on http://${config.host}:${config.port}`);
  logger.info(`Environment: ${config.nodeEnv}`);
  logger.info(`Cache directory: ${config.cacheDir}`);
  logger.info(`Admin panel: http://${config.host}:${config.port}/admin`);
});

// ============================================================
// Graceful shutdown
// ============================================================

let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}, shutting down gracefully...`);

  // Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed');
  });

  // Close Socket.IO
  io.close();

  // Stop all downloads
  try {
    await destroyDownloader();
  } catch (err) {
    logger.error(`Error destroying downloader: ${(err as Error).message}`);
  }

  // Close database
  try {
    closeDatabase();
  } catch (err) {
    logger.error(`Error closing database: ${(err as Error).message}`);
  }

  logger.info('Graceful shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});

export { app, server, io };
