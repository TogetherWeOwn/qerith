export const qualificationFixtureNamespace = 'drive-qualification/full-v0/';

/** @param {unknown} value @returns {value is string} */
export function isQualificationRunNumber(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
}

/**
 * @param {{ runId: unknown, attempt: unknown }} identity
 * @returns {`${typeof qualificationFixtureNamespace}${string}/${string}/`}
 */
export function qualificationPrefix({ runId, attempt }) {
  if (!isQualificationRunNumber(runId) || !isQualificationRunNumber(attempt)) {
    throw new Error('Invalid qualification run or attempt.');
  }
  return `${qualificationFixtureNamespace}${runId}/${attempt}/`;
}

export const firstReleaseSmokeNamespace = 'drive-first-release-smoke/';

/**
 * @param {{ runId: unknown, attempt: unknown }} identity
 * @returns {`${typeof firstReleaseSmokeNamespace}${string}/${string}/`}
 */
export function firstReleaseSmokePrefix({ runId, attempt }) {
  if (!isQualificationRunNumber(runId) || !isQualificationRunNumber(attempt)) {
    throw new Error('Invalid first-release smoke run or attempt.');
  }
  return `${firstReleaseSmokeNamespace}${runId}/${attempt}/`;
}
