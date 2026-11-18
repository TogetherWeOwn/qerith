declare module 'cloudflare:workers' {
  export const env: import('./lib/server/request-auth').DriveAuthEnv;
}
