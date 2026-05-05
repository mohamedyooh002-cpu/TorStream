// ============================================================
// TorrentStream — Type Definitions
// ============================================================

/** Torrent search result from a provider */
export interface TorrentSearchResult {
  title: string;
  magnetUri: string;
  infoHash: string;
  seeders: number;
  leechers: number;
  size: string;
  sizeBytes: number;
  source: string;
  category: string;
  uploadDate?: string;
}

/** Common interface for torrent search providers */
export interface TorrentSearchProvider {
  name: string;
  search(query: string): Promise<TorrentSearchResult[]>;
  testConnection(): Promise<boolean>;
}

/** Movie metadata from OMDb */
export interface MovieMetadata {
  title: string;
  year: string;
  rated: string;
  released: string;
  runtime: string;
  genre: string;
  director: string;
  actors: string;
  plot: string;
  language: string;
  country: string;
  awards: string;
  poster: string;
  imdbRating: string;
  imdbID: string;
  type: string;
  quality: string;
}

/** Downloaded file within a torrent */
export interface DownloadedFile {
  name: string;
  path: string;
  size: number;
  selected: boolean;
}

/** Download job tracked by the download manager */
export interface DownloadJob {
  id: string;
  infoHash: string;
  torrent: unknown;
  status: 'downloading' | 'converting' | 'ready' | 'error' | 'paused';
  progress: number;
  downloadSpeed: number;
  numPeers: number;
  files: DownloadedFile[];
  savePath: string;
  hlsPath: string | null;
  error: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

/** Movie row in SQLite */
export interface MovieRow {
  id: string;
  _id?: string;
  info_hash: string;
  title: string;
  original_torrent_title: string | null;
  year: string | null;
  quality: string | null;
  seeders: number | null;
  leechers: number | null;
  size_bytes: number | null;
  imdb_id: string | null;
  imdb_rating: string | null;
  genre: string | null;
  plot: string | null;
  poster: string | null;
  local_poster: string | null;
  hls_path: string | null;
  video_path: string | null;
  status: string;
  added_at: string;
  downloaded_at: string | null;
  torrent_source: string | null;
  duration_seconds: number | null;
  play_count?: number;
}

/** OMDb cache row in SQLite */
export interface MetadataCacheRow {
  search_title: string;
  response_json: string;
  fetched_at: string;
}

/** Download log row in SQLite */
export interface DownloadLogRow {
  id: string;
  info_hash: string;
  torrent_title: string;
  status: string;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  file_size: number | null;
}

/** Admin session row in SQLite */
export interface AdminSessionRow {
  token: string;
  created_at: string;
  expires_at: string;
}

/** Socket.IO download progress event data */
export interface DownloadProgressEvent {
  type: 'download-progress';
  data: {
    id: string;
    infoHash: string;
    progress: number;
    downloadSpeed: number;
    numPeers: number;
    status: string;
  };
}

/** Socket.IO conversion progress event data */
export interface ConversionProgressEvent {
  type: 'conversion-progress';
  data: {
    id: string;
    infoHash: string;
    progress: number;
    status: string;
  };
}

/** API response wrapper for paginated results */
export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/** Public stats response */
export interface PublicStats {
  totalMovies: number;
  totalSizeBytes: number;
  latestAdded: string | null;
}

/** Admin dashboard stats */
export interface AdminDashboardStats {
  totalMovies: number;
  cacheSizeBytes: number;
  diskFreeBytes: number;
  diskTotalBytes: number;
  activeDownloads: number;
  failedJobs: number;
}

/** Disk usage details */
export interface DiskUsage {
  total: number;
  used: number;
  free: number;
  cacheSize: number;
  perMovie: Array<{
    id: string;
    title: string;
    sizeBytes: number;
  }>;
}

/** Application configuration loaded from .env */
export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: string;
  adminUsername: string;
  adminPassword: string;
  jwtSecret: string;
  cacheDir: string;
  maxCacheSizeGb: number;
  maxFileSizeGb: number;
  minFileSizeMb: number;
  minSeeders: number;
  maxConcurrentDownloads: number;
  seedAfterDownload: boolean;
  downloadTimeoutMinutes: number;
  omdbApiKey: string;
  torrentPort: number;
  dhtEnabled: boolean;
  searchRateLimitPerMin: number;
  downloadRequestRateLimitPerHour: number;
  corsOrigin: string;
}

/** Search result returned to frontend (enriched) */
export interface EnrichedSearchResult extends TorrentSearchResult {
  metadata: MovieMetadata | null;
  cached: boolean;
  movieId: string | null;
  status: string | null;
  quality: string;
}

/** Express request with admin flag */
export interface AuthenticatedRequest {
  isAdmin?: boolean;
  ip?: string;
}

/** Quality extraction result */
export interface QualityInfo {
  quality: string;
  isCam: boolean;
}
