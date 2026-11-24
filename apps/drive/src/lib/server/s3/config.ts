export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Defaults to path-style for existing deployment bindings and fixtures. */
  pathStyle?: boolean;
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
    endpoint.username || endpoint.password || !/^https?:\/\/[^/?#]+\/?$/i.test(config.endpoint) ||
    endpoint.pathname !== '/' ||
    config.endpoint.includes('?') || config.endpoint.includes('#') ||
    config.endpoint.includes('\\') || /\s/.test(config.endpoint)
  ) throw new Error('Invalid S3 endpoint');

  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) ||
    config.bucket.includes('..') || /^\d+\.\d+\.\d+\.\d+$/.test(config.bucket) ||
    !config.region || /[^a-zA-Z0-9-]/.test(config.region) ||
    !config.accessKeyId || /[^\x21-\x2b\x2d-\x2e\x30-\x7e]/.test(config.accessKeyId) || !config.secretAccessKey.trim()
  ) throw new Error('Invalid S3 configuration');
  if (config.pathStyle === false && (local || endpoint.hostname.includes(':') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(endpoint.hostname))) throw new Error('Invalid virtual-hosted S3 endpoint');

  return Object.freeze({ ...config, endpoint: endpoint.origin });
}

/** Effective HTTPS origin, used by both the signer and the owner-storage egress policy. */
export function s3Address(config: Readonly<S3Config>) {
  const endpoint = new URL(config.endpoint);
  if (config.pathStyle === false) {
    endpoint.hostname = `${config.bucket}.${endpoint.hostname}`;
    return { origin: endpoint.origin, prefix: '/' };
  }
  return { origin: endpoint.origin, prefix: `/${config.bucket}/` };
}
