# TorrentStream

A Netflix-style streaming platform powered by publicly available torrents. Search, download, convert to HLS, and stream — all from a beautiful web interface.

## Prerequisites

- **Node.js 20+** (LTS recommended)
- **ffmpeg** and **ffprobe** installed and available in PATH
- **Enough disk space** for video caching (configurable, default 500GB limit)
- A free **OMDb API key** from [https://www.omdbapi.com/apikey.aspx](https://www.omdbapi.com/apikey.aspx)

### Installing ffmpeg

**Ubuntu/Debian:**
```bash
sudo apt update && sudo apt install ffmpeg
```

**macOS:**
```bash
brew install ffmpeg
```

**Windows:**
Download from [https://ffmpeg.org/download.html](https://ffmpeg.org/download.html) and add to PATH.

## Installation

```bash
# Clone the repository
git clone <repo-url>
cd torrentstream

# Install dependencies
npm install

# Create cache directory
npm run setup

# Copy and edit the environment file
cp .env.example .env
# Edit .env with your settings (see Configuration section below)
```

## Configuration

Edit the `.env` file with your settings:

```env
# Server
PORT=3000
NODE_ENV=production
HOST=0.0.0.0

# Admin — CHANGE THESE!
ADMIN_USERNAME=admin
ADMIN_PASSWORD=YOUR_STRONG_PASSWORD_HERE
JWT_SECRET=YOUR_RANDOM_64_CHAR_SECRET_HERE

# Cache
CACHE_DIR=./cache/videos          # Where downloaded videos are stored
MAX_CACHE_SIZE_GB=500             # Maximum total cache size
MAX_FILE_SIZE_GB=15               # Maximum single file size
MIN_FILE_SIZE_MB=100              # Minimum file size (skip small files)
MIN_SEEDERS=5                     # Minimum seeders to consider a torrent

# Downloads
MAX_CONCURRENT_DOWNLOADS=2        # Parallel downloads
SEED_AFTER_DOWNLOAD=true          # Keep seeding after download
DOWNLOAD_TIMEOUT_MINUTES=60       # Download timeout

# API Keys
OMDB_API_KEY=your_key_here        # Get one free at omdbapi.com

# Torrent
TORRENT_PORT=6881                 # Port for torrent connections
DHT_ENABLED=true                  # Enable DHT for better peer discovery

# Rate Limiting
SEARCH_RATE_LIMIT_PER_MIN=10
DOWNLOAD_REQUEST_RATE_LIMIT_PER_HOUR=3

# CORS
CORS_ORIGIN=*
```

**Important:** Always change `ADMIN_PASSWORD` and `JWT_SECRET` before deploying to production!

## Running

### Development

```bash
npm run dev
```

This uses `tsx watch` for hot-reloading during development. The server will restart automatically when files change.

### Production

```bash
# Build TypeScript
npm run build

# Start with PM2
pm2 start pm2.config.js

# Or start directly
npm start
```

### PM2 Commands

```bash
pm2 start pm2.config.js     # Start the application
pm2 stop torrentstream      # Stop
pm2 restart torrentstream   # Restart
pm2 logs torrentstream      # View logs
pm2 monit                   # Monitor CPU/Memory
pm2 status                  # Check status
```

## Usage

### Public Interface

1. Open `http://localhost:3000` in your browser
2. Browse movies on the home page
3. Use the search bar to find movies from torrent sources
4. Click a movie card to see details
5. Press the PLAY button to start streaming (if the movie is cached)
6. If a movie isn't cached yet, click "Request Download" from search results

### Admin Dashboard

1. Navigate to `http://localhost:3000/admin`
2. Log in with your admin credentials
3. **Movies Tab:** View all cached movies, reconvert, or delete
4. **Downloads Tab:** Monitor active downloads with real-time progress
5. **Search & Cache Tab:** Search for torrents and trigger downloads
6. **Disk Management Tab:** Monitor disk usage, cleanup errors, clear cache

### Adding Content

There are three ways to add content:

1. **Search & Download (Admin):** Use the Search & Cache tab in the admin dashboard
2. **Search & Download (Public):** Use the public search page and click "Request Download"
3. **API:** POST to `/api/admin/download` with `{ magnetUri, infoHash }`

### Auto-Search & Cache

From the admin dashboard, use "Search & Cache" to search for a movie and automatically download the top results:

```
POST /api/admin/search-and-cache
{ "query": "The Matrix", "maxResults": 5 }
```

## Architecture

```
[User Browser]
    │
    ├── GET /api/movies ──► [Express API] ──► [SQLite] ──► JSON
    │
    ├── GET /stream/:id/master.m3u8 ──► [Express] ──► [HLS files] ──► Stream
    │
    ├── GET /admin ──► [Static HTML] ──► [JWT-protected API calls]
    │
    └── POST /api/search ──► [Express] ──► [Torrent APIs] ──► [OMDb] ──► JSON

[Background Process]
    ├── Torrent Search & Filter (on trigger)
    ├── Torrent Download (WebTorrent)
    ├── File Verification (ffprobe)
    ├── HLS Conversion (ffmpeg -c:v copy remux)
    ├── Cache to Disk
    └── Update SQLite
```

## Project Structure

```
torrentstream/
├── .env                          # Environment configuration
├── .env.example                  # Template for .env
├── .gitignore
├── package.json
├── tsconfig.json
├── pm2.config.js                 # PM2 ecosystem config
├── src/
│   ├── index.ts                  # Entry point
│   ├── config.ts                 # Load .env, export typed config
│   ├── types/index.ts            # TypeScript interfaces
│   ├── routes/
│   │   ├── public.ts             # Public API routes
│   │   ├── admin.ts              # Admin API routes (JWT-protected)
│   │   └── stream.ts             # HLS streaming routes
│   ├── middleware/
│   │   ├── auth.ts               # JWT authentication
│   │   ├── rateLimit.ts          # In-memory rate limiter
│   │   ├── errorHandler.ts       # Global error handler
│   │   └── requestLogger.ts      # Request logging
│   ├── services/
│   │   ├── database.ts           # SQLite with WAL mode
│   │   ├── search.ts             # Torrent search (YTS, ThePirateBay, 1337x)
│   │   ├── metadata.ts           # OMDb API integration
│   │   ├── downloader.ts         # WebTorrent download manager
│   │   ├── hls-converter.ts      # FFmpeg HLS conversion
│   │   └── cache.ts              # Disk space & cache management
│   └── utils/
│       ├── logger.ts             # Winston with daily rotation
│       ├── helpers.ts            # File size, title parsing utilities
│       └── validators.ts         # Input validation
├── public/
│   ├── index.html                # Netflix-style public UI
│   ├── style.css                 # Custom styles
│   ├── app.js                    # Public frontend logic
│   ├── admin.html                # Admin dashboard
│   ├── admin.js                  # Admin frontend logic
│   ├── admin.css                 # Admin styles
│   └── img/
│       └── placeholder-poster.svg
└── cache/                        # Runtime cache (gitignored)
    └── videos/
        └── {infoHash}/
            ├── video.mkv
            └── hls/
                ├── master.m3u8
                ├── segment_*.ts
                └── poster.jpg
```

## API Reference

### Public Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/movies` | List cached movies (paginated, filterable) |
| GET | `/api/movies/:id` | Single movie details |
| GET | `/api/genres` | List distinct genres |
| GET | `/api/qualities` | List distinct qualities |
| GET | `/api/stats` | Public stats |
| GET | `/api/poster/:id` | Serve poster image |
| GET | `/api/search?q=...` | Search torrent APIs (rate-limited) |
| POST | `/api/request-download` | Queue a download (rate-limited) |

### Admin Endpoints (JWT Required)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/admin/login` | Get JWT token |
| GET | `/api/admin/dashboard` | Dashboard stats |
| GET | `/api/admin/movies` | All movies including non-ready |
| GET | `/api/admin/downloads` | Active download jobs |
| POST | `/api/admin/download` | Trigger download |
| POST | `/api/admin/download/batch` | Queue multiple downloads |
| DELETE | `/api/admin/movies/:id` | Delete one movie |
| DELETE | `/api/admin/movies` | Delete all movies |
| POST | `/api/admin/movies/:id/reconvert` | Re-run HLS conversion |
| POST | `/api/admin/search-and-cache` | Search and auto-download |
| GET | `/api/admin/disk` | Disk usage details |
| POST | `/api/admin/cleanup` | Cleanup errors and orphans |
| POST | `/api/admin/downloads/:id/cancel` | Cancel download |

### Streaming Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/stream/:id/master.m3u8` | HLS master playlist |
| GET | `/stream/:id/segment_:num.ts` | HLS video segments |
| GET | `/stream/:id/poster.jpg` | Movie poster |

## Docker (Optional)

While not included in this project, you can easily Dockerize it:

```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
COPY public/ ./public/
COPY .env ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

## Troubleshooting

### ffmpeg not found
Make sure ffmpeg is installed and in your PATH:
```bash
ffmpeg -version
ffprobe -version
```

### Downloads stuck at 0%
- Check your internet connection and firewall settings
- The torrent port (default 6881) needs to be open for incoming connections
- Some ISPs block torrent traffic — try enabling DHT and using different trackers

### OMDb API errors
- Verify your API key is set in `.env`
- Free tier allows 1000 requests/day
- Metadata is cached in SQLite, so repeat lookups don't count against your limit

### Database locked errors
- SQLite with WAL mode should handle concurrent reads well
- If you see "database is locked" errors, ensure only one instance is running

### Out of disk space
- Check the Disk Management tab in admin
- Increase `MAX_CACHE_SIZE_GB` or delete old movies
- The system checks disk space before each download

### HLS conversion failing
- Check ffmpeg supports the source codec: `ffmpeg -codecs | grep x264`
- If source is not H.264/H.265, the system will re-encode (slower)
- Check logs in `./logs/` for detailed ffmpeg error output

## License

MIT
