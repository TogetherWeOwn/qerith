declare module 'cloudflare:workers' {
  export const env: import('./lib/server/upload-routes').UploadRouteEnv & import('./lib/server/published-download').DownloadEnv;
}

declare class FixedLengthStream {
  constructor(length: number);
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}
