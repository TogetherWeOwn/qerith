declare module 'cloudflare:workers' {
  interface DriveStatement {
    bind(...values: (string | number | null)[]): DriveStatement;
    first<T>(): Promise<T | null>;
    all<T>(): Promise<{ results: T[] }>;
  }

  export const env: Omit<import('./lib/server/request-auth').DriveAuthEnv, 'DB'> &
    import('./lib/server/published-download').DownloadEnv & { DB?: { prepare(sql: string): DriveStatement } };
}

declare class FixedLengthStream {
  constructor(length: number);
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}
