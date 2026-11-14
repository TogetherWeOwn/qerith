export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Enable HTTP only for an explicitly configured loopback fixture. */
  allowLocalHttp?: boolean;
}

export function validateConfig(config: S3Config): Readonly<S3Config> {
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new Error('Invalid S3 endpoint');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (
    (endpoint.protocol !== 'https:' && !(config.allowLocalHttp === true && local && endpoint.protocol === 'http:')) ||
    endpoint.username || endpoint.password || endpoint.pathname !== '/' ||
    config.endpoint.includes('?') || config.endpoint.includes('#') ||
    config.endpoint.includes('\\') || config.endpoint.trim() !== config.endpoint
  ) throw new Error('Invalid S3 endpoint');

  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) ||
    config.bucket.includes('..') || /^\d+\.\d+\.\d+\.\d+$/.test(config.bucket) ||
    !config.region || !config.accessKeyId || !config.secretAccessKey
  ) throw new Error('Invalid S3 configuration');

  return Object.freeze({ ...config, endpoint: endpoint.origin });
}
