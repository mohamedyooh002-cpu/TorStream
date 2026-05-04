import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { MovieRow, MetadataCacheRow, DownloadLogRow, AdminSessionRow, PaginatedResponse } from '../types/index.js';
import logger from '../utils/logger.js';

const DB_PATH = process.env.DB_PATH || './torrentstream.db';

let db: Database.Database;

/**
 * Initialize the database, create tables, enable WAL mode
 */
export function initDatabase(): Database.Database {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(DB_PATH);

  // Enable WAL mode for concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  createTables();
  logger.info('Database initialized', { path: DB_PATH });

  return db;
}

function createTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS movies (
      id TEXT PRIMARY KEY,
      info_hash TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      original_torrent_title TEXT,
      year TEXT,
      quality TEXT,
      seeders INTEGER,
      leechers INTEGER,
      size_bytes INTEGER,
      imdb_id TEXT,
      imdb_rating TEXT,
      genre TEXT,
      plot TEXT,
      poster TEXT,
      local_poster TEXT,
      hls_path TEXT,
      video_path TEXT,
      status TEXT DEFAULT 'ready',
      added_at TEXT DEFAULT (datetime('now')),
      downloaded_at TEXT,
      torrent_source TEXT,
      duration_seconds INTEGER
    );

    CREATE TABLE IF NOT EXISTS metadata_cache (
      search_title TEXT PRIMARY KEY,
      response_json TEXT,
      fetched_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS download_log (
      id TEXT PRIMARY KEY,
      info_hash TEXT,
      torrent_title TEXT,
      status TEXT,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      file_size INTEGER
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS movie_plays (
      id TEXT PRIMARY KEY,
      movie_id TEXT NOT NULL,
      user_key TEXT,
      user_agent TEXT,
      played_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_movies_info_hash ON movies(info_hash);
    CREATE INDEX IF NOT EXISTS idx_movies_status ON movies(status);
    CREATE INDEX IF NOT EXISTS idx_movies_genre ON movies(genre);
    CREATE INDEX IF NOT EXISTS idx_movies_quality ON movies(quality);
    CREATE INDEX IF NOT EXISTS idx_movies_added_at ON movies(added_at);
    CREATE INDEX IF NOT EXISTS idx_movies_imdb_rating ON movies(imdb_rating);
    CREATE INDEX IF NOT EXISTS idx_download_log_info_hash ON download_log(info_hash);
    CREATE INDEX IF NOT EXISTS idx_movie_plays_movie_id ON movie_plays(movie_id);
    CREATE INDEX IF NOT EXISTS idx_movie_plays_played_at ON movie_plays(played_at);
    CREATE INDEX IF NOT EXISTS idx_movie_plays_user_movie_time ON movie_plays(user_key, movie_id, played_at);
  `);
}

/**
 * Get the raw database instance
 */
export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}

// ============================================================
// Movies CRUD
// ============================================================

export function insertMovie(movie: {
  id?: string;
  info_hash: string;
  title: string;
  original_torrent_title?: string;
  year?: string;
  quality?: string;
  seeders?: number;
  leechers?: number;
  size_bytes?: number;
  imdb_id?: string;
  imdb_rating?: string;
  genre?: string;
  plot?: string;
  poster?: string;
  local_poster?: string;
  hls_path?: string;
  video_path?: string;
  status?: string;
  downloaded_at?: string;
  torrent_source?: string;
  duration_seconds?: number;
}): string {
  const id = movie.id || uuidv4();
  const stmt = getDb().prepare(`
    INSERT INTO movies (id, info_hash, title, original_torrent_title, year, quality,
      seeders, leechers, size_bytes, imdb_id, imdb_rating, genre, plot, poster,
      local_poster, hls_path, video_path, status, downloaded_at, torrent_source, duration_seconds)
    VALUES (@id, @info_hash, @title, @original_torrent_title, @year, @quality,
      @seeders, @leechers, @size_bytes, @imdb_id, @imdb_rating, @genre, @plot, @poster,
      @local_poster, @hls_path, @video_path, @status, @downloaded_at, @torrent_source, @duration_seconds)
  `);
  stmt.run({
    id,
    info_hash: movie.info_hash,
    title: movie.title,
    original_torrent_title: movie.original_torrent_title || null,
    year: movie.year || null,
    quality: movie.quality || null,
    seeders: movie.seeders || null,
    leechers: movie.leechers || null,
    size_bytes: movie.size_bytes || null,
    imdb_id: movie.imdb_id || null,
    imdb_rating: movie.imdb_rating || null,
    genre: movie.genre || null,
    plot: movie.plot || null,
    poster: movie.poster || null,
    local_poster: movie.local_poster || null,
    hls_path: movie.hls_path || null,
    video_path: movie.video_path || null,
    status: movie.status || 'downloading',
    downloaded_at: movie.downloaded_at || null,
    torrent_source: movie.torrent_source || null,
    duration_seconds: movie.duration_seconds || null
  });
  return id;
}

export function getMovieById(id: string): MovieRow | undefined {
  const stmt = getDb().prepare('SELECT * FROM movies WHERE id = ?');
  return stmt.get(id) as MovieRow | undefined;
}

export function getMovieByInfoHash(infoHash: string): MovieRow | undefined {
  const stmt = getDb().prepare('SELECT * FROM movies WHERE info_hash = ?');
  return stmt.get(infoHash) as MovieRow | undefined;
}

export function updateMovie(id: string, updates: Partial<MovieRow>): void {
  const allowedFields = [
    'title', 'year', 'quality', 'seeders', 'leechers', 'size_bytes',
    'imdb_id', 'imdb_rating', 'genre', 'plot', 'poster', 'local_poster',
    'hls_path', 'video_path', 'status', 'downloaded_at', 'torrent_source', 'duration_seconds'
  ];
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const key of allowedFields) {
    if (key in updates && (updates as Record<string, unknown>)[key] !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = (updates as Record<string, unknown>)[key];
    }
  }

  if (fields.length === 0) return;

  const sql = `UPDATE movies SET ${fields.join(', ')} WHERE id = @id`;
  const stmt = getDb().prepare(sql);
  stmt.run(values);
}

export function deleteMovie(id: string): void {
  const stmt = getDb().prepare('DELETE FROM movies WHERE id = ?');
  stmt.run(id);
}

export function deleteAllMovies(): number {
  const result = getDb().prepare('DELETE FROM movies').run();
  return result.changes;
}

export function listMovies(options: {
  sort?: string;
  genre?: string;
  quality?: string;
  search?: string;
  page?: number;
  limit?: number;
  status?: string;
}): PaginatedResponse<MovieRow> {
  const page = Math.max(options.page || 1, 1);
  const limit = Math.min(Math.max(options.limit || 20, 1), 100);
  const offset = (page - 1) * limit;

  const whereClauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (options.status) {
    whereClauses.push('status = @status');
    params.status = options.status;
  } else {
    whereClauses.push("status IN ('ready', 'downloading', 'converting', 'error')");
  }

  if (options.genre) {
    whereClauses.push('genre LIKE @genre');
    params.genre = `%${options.genre}%`;
  }

  if (options.quality) {
    whereClauses.push('quality = @quality');
    params.quality = options.quality;
  }

  if (options.search) {
    whereClauses.push('(title LIKE @search OR original_torrent_title LIKE @search)');
    params.search = `%${options.search}%`;
  }

  const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

  // Determine sort
  let orderStr = 'added_at DESC';
  const sortMap: Record<string, string> = {
    'seeders': 'seeders DESC',
    'imdb_rating': 'CAST(imdb_rating AS REAL) DESC NULLS LAST',
    'year': 'year DESC',
    'added_at': 'added_at DESC',
    'title': 'title ASC',
    'size_bytes': 'size_bytes DESC'
  };
  if (options.sort && sortMap[options.sort]) {
    orderStr = sortMap[options.sort];
  }

  // Get total count
  const countSql = `SELECT COUNT(*) as total FROM movies ${whereStr}`;
  const countRow = getDb().prepare(countSql).get(params) as { total: number };
  const total = countRow.total;

  // Get paginated results
  const dataSql = `SELECT * FROM movies ${whereStr} ORDER BY ${orderStr} LIMIT @limit OFFSET @offset`;
  params.limit = limit;
  params.offset = offset;
  const rows = getDb().prepare(dataSql).all(params) as MovieRow[];

  return {
    data: rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  };
}

export function getDistinctGenres(): string[] {
  const rows = getDb().prepare(
    "SELECT DISTINCT genre FROM movies WHERE genre IS NOT NULL AND status = 'ready'"
  ).all() as Array<{ genre: string }>;

  const genres = new Set<string>();
  for (const row of rows) {
    if (row.genre) {
      row.genre.split(',').map(g => g.trim()).filter(Boolean).forEach(g => genres.add(g));
    }
  }
  return Array.from(genres).sort();
}

export function getDistinctQualities(): string[] {
  const rows = getDb().prepare(
    "SELECT DISTINCT quality FROM movies WHERE quality IS NOT NULL AND status = 'ready' ORDER BY quality"
  ).all() as Array<{ quality: string }>;
  return rows.map(r => r.quality);
}

export function getPublicStats(): { totalMovies: number; totalSizeBytes: number; latestAdded: string | null } {
  const row = getDb().prepare(
    "SELECT COUNT(*) as totalMovies, COALESCE(SUM(size_bytes), 0) as totalSizeBytes, MAX(added_at) as latestAdded FROM movies WHERE status = 'ready'"
  ).get() as { totalMovies: number; totalSizeBytes: number; latestAdded: string | null };
  return row;
}

export function getReadyMoviesCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) as cnt FROM movies WHERE status = 'ready'").get() as { cnt: number };
  return row.cnt;
}

export function getErrorMoviesCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) as cnt FROM movies WHERE status = 'error'").get() as { cnt: number };
  return row.cnt;
}

export function getDownloadingMoviesCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) as cnt FROM movies WHERE status IN ('downloading', 'converting')").get() as { cnt: number };
  return row.cnt;
}

export function verifyMoviesOnDisk(): void {
  const movies = getDb().prepare("SELECT id, hls_path, video_path, status FROM movies WHERE status = 'ready'").all() as MovieRow[];
  for (const movie of movies) {
    if (movie.hls_path && !fs.existsSync(movie.hls_path)) {
      logger.warn(`Movie ${movie.id} (${movie.title}) has missing HLS path, marking as error`);
      updateMovie(movie.id, { status: 'error' } as Partial<MovieRow>);
    }
  }
}

// ============================================================
// Metadata Cache
// ============================================================

export function getCachedMetadata(searchTitle: string): string | null {
  const stmt = getDb().prepare('SELECT response_json FROM metadata_cache WHERE search_title = ?');
  const row = stmt.get(searchTitle) as { response_json: string } | undefined;
  return row ? row.response_json : null;
}

export function setCachedMetadata(searchTitle: string, responseJson: string): void {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO metadata_cache (search_title, response_json, fetched_at)
    VALUES (?, ?, datetime('now'))
  `);
  stmt.run(searchTitle, responseJson);
}

// ============================================================
// Download Log
// ============================================================

export function insertDownloadLog(entry: {
  id?: string;
  info_hash: string;
  torrent_title: string;
  status: string;
  error?: string;
  started_at: string;
  completed_at?: string;
  file_size?: number;
}): string {
  const id = entry.id || uuidv4();
  const stmt = getDb().prepare(`
    INSERT INTO download_log (id, info_hash, torrent_title, status, error, started_at, completed_at, file_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, entry.info_hash, entry.torrent_title, entry.status, entry.error || null, entry.started_at, entry.completed_at || null, entry.file_size || null);
  return id;
}

export function updateDownloadLog(id: string, status: string, error?: string, completedAt?: string): void {
  const stmt = getDb().prepare(`
    UPDATE download_log SET status = ?, error = ?, completed_at = ? WHERE id = ?
  `);
  stmt.run(status, error || null, completedAt || null, id);
}

export function getDownloadLogs(limit = 50): DownloadLogRow[] {
  const stmt = getDb().prepare('SELECT * FROM download_log ORDER BY started_at DESC LIMIT ?');
  return stmt.all(limit) as DownloadLogRow[];
}

// ============================================================
// Admin Sessions
// ============================================================

export function createAdminSession(token: string, expiresAt: string): void {
  const stmt = getDb().prepare(`
    INSERT INTO admin_sessions (token, created_at, expires_at)
    VALUES (?, datetime('now'), ?)
  `);
  stmt.run(token, expiresAt);
}

export function getAdminSession(token: string): AdminSessionRow | undefined {
  const stmt = getDb().prepare("SELECT * FROM admin_sessions WHERE token = ? AND expires_at > datetime('now')");
  return stmt.get(token) as AdminSessionRow | undefined;
}

export function deleteAdminSession(token: string): void {
  const stmt = getDb().prepare('DELETE FROM admin_sessions WHERE token = ?');
  stmt.run(token);
}

export function cleanupExpiredSessions(): void {
  const stmt = getDb().prepare("DELETE FROM admin_sessions WHERE expires_at <= datetime('now')");
  const result = stmt.run();
  if (result.changes > 0) {
    logger.info(`Cleaned up ${result.changes} expired admin sessions`);
  }
}

// ============================================================
// Movie Play Tracking
// ============================================================

export function recordMoviePlay(movieId: string, userKey?: string, userAgent?: string): boolean {
  const movie = getMovieById(movieId);
  if (!movie || movie.status !== 'ready') return false;

  // De-duplicate accidental rapid repeats from the same user for 10 minutes.
  if (userKey) {
    const existing = getDb().prepare(`
      SELECT id
      FROM movie_plays
      WHERE movie_id = ?
        AND user_key = ?
        AND played_at >= datetime('now', '-10 minutes')
      LIMIT 1
    `).get(movieId, userKey) as { id: string } | undefined;

    if (existing) return false;
  }

  const stmt = getDb().prepare(`
    INSERT INTO movie_plays (id, movie_id, user_key, user_agent, played_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);
  stmt.run(uuidv4(), movieId, userKey || null, userAgent || null);
  return true;
}

export function listTrendingMovies(limit = 20): MovieRow[] {
  const rows = getDb().prepare(`
    SELECT m.*, COUNT(mp.id) AS play_count
    FROM movies m
    LEFT JOIN movie_plays mp ON mp.movie_id = m.id
    WHERE m.status = 'ready'
    GROUP BY m.id
    ORDER BY play_count DESC, datetime(m.added_at) DESC
    LIMIT ?
  `).all(limit) as MovieRow[];

  return rows;
}

export function listRecentlyAddedMovies(limit = 20, excludeIds: string[] = []): MovieRow[] {
  const params: Record<string, unknown> = { limit };
  let where = "WHERE status = 'ready'";

  if (excludeIds.length > 0) {
    const placeholders = excludeIds.map((_, i) => `@id${i}`);
    excludeIds.forEach((id, i) => { params[`id${i}`] = id; });
    where += ` AND id NOT IN (${placeholders.join(', ')})`;
  }

  const sql = `
    SELECT *
    FROM movies
    ${where}
    ORDER BY datetime(added_at) DESC
    LIMIT @limit
  `;
  return getDb().prepare(sql).all(params) as MovieRow[];
}

export function listNewlyAddedMovies(limit = 20, excludeIds: string[] = []): MovieRow[] {
  return listRecentlyAddedMovies(limit, excludeIds);
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    logger.info('Database connection closed');
  }
}
