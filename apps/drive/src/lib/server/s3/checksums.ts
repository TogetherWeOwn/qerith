const checksumHeaders = ['x-amz-checksum-crc32', 'x-amz-checksum-crc32c', 'x-amz-checksum-crc64nvme', 'x-amz-checksum-sha1', 'x-amz-checksum-sha256', 'x-amz-checksum-type'];

/** Preserve provider evidence without interpreting it as a local digest. */
export function returnedChecksums(headers: Headers): Record<string, string> | undefined {
  const checksums: Record<string, string> = {};
  for (const name of checksumHeaders) {
    const value = headers.get(name);
    if (value !== null) checksums[name] = value;
  }
  return Object.keys(checksums).length ? checksums : undefined;
}
