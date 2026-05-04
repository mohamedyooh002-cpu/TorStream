declare module 'webtorrent' {
  import { EventEmitter } from 'events';

  interface TorrentFile {
    name: string;
    path: string;
    length: number;
    deselect(): void;
    select(): void;
    createReadStream(opts?: { start?: number; end?: number }): NodeJS.ReadableStream;
  }

  interface Torrent extends EventEmitter {
    infoHash: string;
    magnetURI: string;
    files: TorrentFile[];
    progress: number;
    downloadSpeed: number;
    uploadSpeed: number;
    numPeers: number;
    timeRemaining: number;
    totalSize: number;
    done: boolean;
    name: string;
    length: number;
    destroy(opts?: { destroyStore?: boolean }, callback?: (err?: Error) => void): void;
  }

  interface WebTorrentOptions {
    maxConns?: number;
    tracker?: boolean;
    dht?: boolean;
    utp?: boolean;
    webSeeds?: boolean;
  }

  class WebTorrent extends EventEmitter {
    constructor(opts?: WebTorrentOptions);
    add(magnetURI: string, opts?: { path?: string; announce?: string[] }, ontorrent?: (torrent: Torrent) => void): Torrent;
    remove(torrent: Torrent | string, opts?: { destroyStore?: boolean }, callback?: (err?: Error) => void): void;
    destroy(callback?: (err?: Error) => void): void;
    torrents: Torrent[];
  }

  export default WebTorrent;
}
