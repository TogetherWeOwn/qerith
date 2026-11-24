import { storageSettingsPath } from '../drive-navigation.ts';

export const routeMethods = ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'] as const;
export type RouteMethod = typeof routeMethods[number];
export type StagingGate = 'invite' | 'read-grants' | 'shared' | 'upload-resume' | 'owner-storage';
export type RouteAccess = 'public' | 'owner' | 'member' | 'owner-or-member' | 'owner-or-invited-member' | 'owner-or-multipart-member';
export type SignedOut = 'dispatch' | 401 | 'return-to-route' | 'return-to-root';
export type CeremonyStep = 'challenge' | 'restart' | 'verify';
export type InviteStep = 'present' | 'challenge' | 'enroll';
export type StagingRouteTarget =
  | { kind: 'sign-in' | 'root' | 'root-data' | 'invite' | 'people' | 'storage-settings' | 'folder' | 'shared' | 'download' |
      'upload' | 'upload-resume' | 'owner-lifecycle' | 'read-grant' | 'eligible-recipients' | 'move-destinations' }
  | { kind: 'metadata-write'; operation: 'create-folder' | 'change-entry' }
  | { kind: 'ceremony'; step: CeremonyStep }
  | { kind: 'invite-ceremony'; step: InviteStep };

type Route = {
  path: string;
  methods: readonly RouteMethod[];
  source: 'page' | 'endpoint' | 'worker';
  adapterFallback?: 'excluded';
};
export type StagingRoute = Route & {
  target: StagingRouteTarget;
  gate?: StagingGate;
  access: RouteAccess;
  signedOut: SignedOut;
};
export type StagingExclusion = Route & { excluded: string; signedOut: 404 };

const document = ['GET', 'HEAD'] as const;
const publicAccess = { access: 'public', signedOut: 'dispatch' } as const;
const inviteAccess = { ...publicAccess, gate: 'invite' } as const;
const myDrive = { access: 'owner-or-invited-member', signedOut: 401 } as const;
const invited = { gate: 'invite', access: 'owner-or-member', signedOut: 401 } as const;
const upload = { access: 'owner-or-multipart-member', signedOut: 401 } as const;
const owner = { gate: 'invite', access: 'owner', signedOut: 401, target: { kind: 'owner-lifecycle' } } as const;
const grants = { gate: 'read-grants', access: 'owner-or-member', signedOut: 401 } as const;

// A bracketed path is the exact SvelteKit route ID or the equivalent Worker
// pattern. Staging admission also applies the canonical wire checks for each
// target. Enrollment, readiness and qualified deletion are separately gated
// before preview dispatch in the generated Worker.
export const stagingRoutes: readonly (StagingRoute | StagingExclusion)[] = [
  { path: '/sign-in', methods: document, source: 'page', target: { kind: 'sign-in' }, ...publicAccess },
  { path: '/invite', methods: document, source: 'page', target: { kind: 'invite' }, ...inviteAccess },
  { path: '/people', methods: ['GET'], source: 'page', target: { kind: 'people' },
    gate: 'invite', access: 'owner', signedOut: 'return-to-route' },
  { path: '/people', methods: ['HEAD'], source: 'page', target: { kind: 'people' },
    gate: 'invite', access: 'owner', signedOut: 401 },
  { path: storageSettingsPath, methods: document, source: 'page', target: { kind: 'storage-settings' },
    gate: 'owner-storage', access: 'owner', signedOut: 'return-to-route' },
  { path: '/f/[folderId]', methods: document, source: 'page', target: { kind: 'folder' }, ...invited },
  { path: '/shared', methods: document, source: 'page', target: { kind: 'shared' },
    gate: 'shared', access: 'member', signedOut: 401 },
  { path: '/', methods: document, source: 'page', target: { kind: 'root' }, ...myDrive, signedOut: 'return-to-route' },
  { path: '/__data.json', methods: ['GET'], source: 'worker', target: { kind: 'root-data' }, ...myDrive },
  ...(['challenge', 'restart', 'verify'] as const).map((step): StagingRoute =>
    ({ path: `/api/sign-in/${step}`, methods: ['POST'], source: 'worker', target: { kind: 'ceremony', step }, ...publicAccess })),
  ...(['present', 'challenge', 'enroll'] as const).map((step): StagingRoute =>
    ({ path: `/api/invite/${step}`, methods: ['POST'], source: 'worker', target: { kind: 'invite-ceremony', step }, ...inviteAccess })),
  { path: '/api/download/[fileId]', methods: ['GET'], source: 'endpoint', target: { kind: 'download' },
    ...myDrive, signedOut: 'return-to-root' },
  { path: '/api/uploads', methods: ['POST'], source: 'endpoint', target: { kind: 'upload' }, ...upload },
  { path: '/api/uploads/[intentId]/parts/[partNumber]', methods: ['PUT'], source: 'endpoint', target: { kind: 'upload' }, ...upload },
  { path: '/api/uploads/[intentId]/complete', methods: ['POST'], source: 'endpoint', target: { kind: 'upload' }, ...upload },
  { path: '/api/uploads/[intentId]/resume', methods: ['GET'], source: 'endpoint', target: { kind: 'upload-resume' },
    gate: 'upload-resume', ...upload },
  { path: '/api/owner/invitations', methods: ['GET', 'POST'], source: 'endpoint', ...owner },
  { path: '/api/owner/invitations/[id]/cancel', methods: ['POST'], source: 'endpoint', ...owner },
  { path: '/api/owner/members/[id]/revoke', methods: ['POST'], source: 'endpoint', ...owner },
  { path: '/api/entries/[entryId]/eligible-recipients', methods: ['GET'], source: 'endpoint',
    adapterFallback: 'excluded', target: { kind: 'eligible-recipients' }, ...grants },
  { path: '/api/entries/[entryId]/read-grants', methods: ['GET'], source: 'endpoint', target: { kind: 'read-grant' }, ...grants },
  { path: '/api/entries/[entryId]/read-grants/[recipientId]', methods: ['PUT', 'DELETE'], source: 'endpoint',
    target: { kind: 'read-grant' }, ...grants },
  { path: '/api/folders', methods: ['POST'], source: 'worker', target: { kind: 'metadata-write', operation: 'create-folder' }, ...invited },
  { path: '/api/entries/[entryId]', methods: ['PATCH'], source: 'worker', target: { kind: 'metadata-write', operation: 'change-entry' }, ...invited },
  { path: '/api/move-destinations', methods: ['GET'], source: 'worker', target: { kind: 'move-destinations' }, ...invited },
  { path: '/api/root-listing', methods: ['GET'], source: 'endpoint', excluded: 'Local preview fixture only', signedOut: 404 },
];
