declare module 'cloudflare:workers' {
  export const env: import('./lib/server/upload-routes').UploadRouteEnv;
}
