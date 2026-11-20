export interface UploadResumeEvidence {
  readonly declaredSize: number;
  readonly parts: readonly {
    readonly partNumber: number;
    readonly sizeBytes: number;
    /** Lowercase hexadecimal SHA-256 of the exact acknowledged bytes. */
    readonly sha256: string;
  }[];
}
