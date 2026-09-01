type Schema = Readonly<Record<string, unknown>>;

const string = { type: 'string' } as const;
const integer = { type: 'integer' } as const;
const boolean = { type: 'boolean' } as const;
const nullableString = { anyOf: [string, { type: 'null' }] } as const;

function object(properties: Record<string, unknown>, required = Object.keys(properties)): Schema {
  return { type: 'object', additionalProperties: false, required, properties };
}

function array(items: Schema): Schema {
  return { type: 'array', items };
}

export const repositoryResponse = object({
  id: integer,
  owner: string,
  ownerType: { type: 'string', enum: ['user', 'group'] },
  name: string,
  description: string,
  visibility: { type: 'string', enum: ['public', 'private'] },
  defaultBranch: string,
  storageKind: { type: 'string', enum: ['hosted_bare', 'imported_bare', 'working_tree'] },
});

export const paginationResponse = object(
  {
    page: integer,
    perPage: integer,
    total: integer,
    hasMore: boolean,
    filters: object({ owner: nullableString, visibility: nullableString, q: nullableString }),
  },
  ['page', 'perPage', 'hasMore'],
);

export const repositoryListResponse = object({
  items: array(repositoryResponse),
  pagination: paginationResponse,
});

export const treeEntryResponse = object(
  {
    mode: string,
    type: { type: 'string', enum: ['blob', 'tree', 'commit'] },
    objectId: string,
    size: { anyOf: [integer, { type: 'null' }] },
    name: string,
    encodedName: string,
    submoduleUrl: string,
    submoduleLink: string,
  },
  ['mode', 'type', 'objectId', 'size', 'name', 'encodedName'],
);

export const treeResponse = object({ items: array(treeEntryResponse), ref: string, path: string });
export const blobResponse = object({
  path: string,
  ref: string,
  size: integer,
  encoding: { type: 'string', const: 'base64' },
  content: string,
});
const blameLineResponse = object({
  lineNumber: integer,
  objectId: string,
  author: string,
  authoredAt: string,
  content: string,
});
export const blameResponse = object({
  path: string,
  ref: string,
  items: array(blameLineResponse),
});

export const commitSummaryResponse = object({
  objectId: string,
  shortId: string,
  subject: string,
  authorName: string,
  authorEmail: string,
  authoredAt: string,
});

const signatureResponse = object({
  state: { type: 'string', enum: ['unsigned', 'valid', 'invalid', 'unknown', 'error'] },
  label: string,
  signer: nullableString,
  keyId: nullableString,
  fingerprint: nullableString,
  identityTrusted: { type: 'boolean', const: false },
});

const diffHunkResponse = object({ header: string, anchor: string, lines: array(string) });
const diffFileResponse = object({
  oldPath: string,
  newPath: string,
  anchor: string,
  status: { type: 'string', enum: ['added', 'deleted', 'modified', 'renamed', 'binary'] },
  additions: integer,
  deletions: integer,
  binary: boolean,
  truncated: boolean,
  hunks: array(diffHunkResponse),
});
export const progressiveDiffResponse = object({
  diff: string,
  additions: integer,
  deletions: integer,
  filesChanged: integer,
  truncated: boolean,
  shownLines: integer,
  hardLineLimit: integer,
  hardFileLimit: integer,
  hardFileByteLimit: integer,
  files: array(diffFileResponse),
});

export const commitDetailResponse = object({
  ...(commitSummaryResponse.properties as Record<string, unknown>),
  treeId: string,
  message: string,
  committerName: string,
  committedAt: string,
  parents: array(string),
  additions: integer,
  deletions: integer,
  filesChanged: integer,
  diff: string,
  truncated: boolean,
  diffFiles: array(diffFileResponse),
  signature: signatureResponse,
});

export const commitListResponse = object({
  items: array(commitSummaryResponse),
  page: integer,
  pagination: paginationResponse,
});

export const refResponse = object({
  name: string,
  objectId: string,
  subject: string,
  committedAt: string,
  signature: { anyOf: [signatureResponse, { type: 'null' }] },
});
export const refListResponse = object({ items: array(refResponse) });

export const comparisonResponse = object({
  base: string,
  head: string,
  mergeBase: string,
  commits: array(commitSummaryResponse),
  additions: integer,
  deletions: integer,
  filesChanged: integer,
  diff: string,
  truncated: boolean,
  diffFiles: array(diffFileResponse),
});

export const okResponse = object({ ok: boolean });
export const objectIdResponse = object({ objectId: string });
export const idResponse = object({ id: integer });
export const userResponse = object({ username: string, displayName: string, createdAt: string });
export const profileResponse = object({
  displayName: string,
  email: nullableString,
  emailPublic: boolean,
  hasAvatar: boolean,
});
export const appearanceResponse = object({
  theme: { type: 'string', enum: ['light', 'dark', 'system'] },
  accent: { type: 'string', enum: ['violet', 'green', 'amber'] },
  uiFont: { type: 'string', enum: ['system', 'humanist'] },
  codeFont: { type: 'string', enum: ['system', 'mono'] },
  reducedMotion: boolean,
  pluginTheme: nullableString,
});
const sessionResponse = object({
  id: integer,
  createdAt: string,
  lastSeenAt: string,
  expiresAt: string,
  userAgent: nullableString,
});
export const sessionListResponse = object({ items: array(sessionResponse) });
export const tokenResponse = object({
  id: integer,
  name: string,
  prefix: string,
  scopes: array(string),
  expiresAt: nullableString,
  lastUsedAt: nullableString,
  createdAt: string,
});
export const tokenListResponse = object({ items: array(tokenResponse) });
export const tokenCreatedResponse = object({ token: string });
export const sshKeyResponse = object({
  id: integer,
  name: string,
  fingerprint: string,
  createdAt: string,
  lastUsedAt: nullableString,
});
export const sshKeyListResponse = object({ items: array(sshKeyResponse) });
const searchResultResponse = object({
  type: string,
  repositoryId: integer,
  owner: string,
  repository: string,
  title: string,
  path: string,
  excerpt: string,
  url: string,
});
const documentationSearchResultResponse = object({ title: string, subtitle: string, url: string });
const directorySearchResultResponse = object({
  type: { type: 'string', enum: ['user', 'group'] },
  title: string,
  subtitle: string,
  url: string,
});
export const searchResponse = object({
  items: array(searchResultResponse),
  directory: array(directorySearchResultResponse),
  documentation: array(documentationSearchResultResponse),
});
const paletteItemResponse = object({ title: string, subtitle: string, url: string });
export const paletteResponse = object({ items: array(paletteItemResponse) });

export const groupSummaryResponse = object({
  id: integer,
  slug: string,
  displayName: string,
  role: { type: 'string', enum: ['member', 'manager', 'owner'] },
});
const groupMemberResponse = object({
  id: integer,
  username: string,
  displayName: string,
  role: { type: 'string', enum: ['member', 'manager', 'owner'] },
});
export const groupResponse = object({
  ...(groupSummaryResponse.properties as Record<string, unknown>),
  members: array(groupMemberResponse),
});
export const groupListResponse = object({
  items: array(groupSummaryResponse),
  pagination: paginationResponse,
});

export const collaboratorListResponse = object({
  items: array(
    object({
      principalType: { type: 'string', enum: ['user', 'group'] },
      principalId: integer,
      level: { type: 'string', enum: ['read', 'write', 'admin'] },
      name: string,
    }),
  ),
});

export const adminUserResponse = object({
  id: integer,
  username: string,
  displayName: string,
  status: { type: 'string', enum: ['active', 'disabled'] },
  isAdmin: boolean,
  createdAt: string,
});
export const adminRepositoryResponse = object({
  id: integer,
  slug: string,
  visibility: { type: 'string', enum: ['public', 'private'] },
  storageKind: { type: 'string', enum: ['hosted_bare', 'imported_bare', 'working_tree'] },
  updatedAt: string,
  owner: string,
});
export const auditEventResponse = object({
  id: integer,
  action: string,
  targetType: string,
  targetId: nullableString,
  createdAt: string,
  ip: nullableString,
  actor: nullableString,
  metadata: string,
});
export const paginatedAdminUsersResponse = object({
  items: array(adminUserResponse),
  pagination: paginationResponse,
});
export const paginatedAdminRepositoriesResponse = object({
  items: array(adminRepositoryResponse),
  pagination: paginationResponse,
});
export const paginatedAuditResponse = object({
  items: array(auditEventResponse),
  pagination: paginationResponse,
});

export const administrationSystemResponse = object({
  version: string,
  counts: object({
    users: integer,
    groups: integer,
    repositories: integer,
    plugins: integer,
    sessions: integer,
  }),
  database: object({ journalMode: string }),
  git: object({ executable: string, version: string }),
});

const pluginPermissionResponse = object({
  capability: string,
  requested: boolean,
  granted: boolean,
});
export const pluginResponse = object({
  id: string,
  name: string,
  version: string,
  runtime: { type: 'string', enum: ['trusted', 'sandboxed'] },
  sourceType: string,
  sourceValue: string,
  packageDigest: nullableString,
  enabled: boolean,
  error: nullableString,
  permissions: array(pluginPermissionResponse),
});
export const pluginListResponse = object({ items: array(pluginResponse) });
const inviteResponse = object({
  id: integer,
  expiresAt: string,
  usedAt: nullableString,
  createdAt: string,
});
export const inviteListResponse = object({ items: array(inviteResponse) });
export const inviteCreatedResponse = object({ token: string });
export const searchStatusResponse = object({
  pending: integer,
  running: integer,
  failed: integer,
  documents: integer,
});
export const runtimeSettingsResponse = object({
  registrationMode: { type: 'string', enum: ['open', 'invite', 'closed'] },
  anonymousPublicRepositories: boolean,
  sessionDays: integer,
  repositoryTrashDays: integer,
  filePreviewBytes: integer,
  diffBytes: integer,
  diffLines: integer,
  diffFiles: integer,
  diffFileBytes: integer,
  archiveBytes: integer,
  lfsObjectBytes: integer,
});
export const rebuildResponse = object({ repositories: integer });

const credentialDescriptor = object(
  {
    id: string,
    type: { type: 'string', const: 'public-key' },
    transports: array(string),
  },
  ['id', 'type'],
);
const extensionInputs = object(
  { appid: string, credProps: boolean, hmacCreateSecret: boolean, minPinLength: boolean },
  [],
);
export const passkeyRegistrationOptionsResponse = object(
  {
    rp: object({ name: string, id: string }, ['name']),
    user: object({ id: string, name: string, displayName: string }),
    challenge: string,
    pubKeyCredParams: array(
      object({ alg: integer, type: { type: 'string', const: 'public-key' } }),
    ),
    timeout: integer,
    excludeCredentials: array(credentialDescriptor),
    authenticatorSelection: object(
      {
        authenticatorAttachment: string,
        requireResidentKey: boolean,
        residentKey: string,
        userVerification: string,
      },
      [],
    ),
    hints: array(string),
    attestation: string,
    attestationFormats: array(string),
    extensions: extensionInputs,
  },
  ['rp', 'user', 'challenge', 'pubKeyCredParams'],
);
export const passkeyAuthenticationOptionsResponse = object(
  {
    challenge: string,
    timeout: integer,
    rpId: string,
    allowCredentials: array(credentialDescriptor),
    userVerification: string,
    hints: array(string),
    extensions: extensionInputs,
  },
  ['challenge'],
);
export const passkeyAuthenticationResultResponse = object({ ok: boolean, redirect: string });
export const passkeyResponse = object({
  id: string,
  name: string,
  createdAt: string,
  lastUsedAt: nullableString,
});
export const passkeyListResponse = object({ items: array(passkeyResponse) });
export const repositoryTransferResponse = object({
  repositoryId: integer,
  owner: string,
  repository: string,
  requestedBy: string,
  expiresAt: string,
});
export const repositoryTransferListResponse = object({
  items: array(repositoryTransferResponse),
});

export const issueLabelResponse = object({ id: integer, name: string, color: string });
export const issueCommentResponse = object({
  id: integer,
  authorUsername: nullableString,
  body: string,
  createdAt: string,
  updatedAt: nullableString,
});
export const issueResponse = object({
  number: integer,
  title: string,
  body: string,
  status: { type: 'string', enum: ['open', 'closed'] },
  authorUsername: nullableString,
  assigneeUsername: nullableString,
  labels: array(issueLabelResponse),
  createdAt: string,
  updatedAt: string,
  closedAt: nullableString,
});
export const issueSummaryResponse = object({
  number: integer,
  title: string,
  status: { type: 'string', enum: ['open', 'closed'] },
  authorUsername: nullableString,
  assigneeUsername: nullableString,
  labels: array(issueLabelResponse),
  createdAt: string,
  updatedAt: string,
  closedAt: nullableString,
});
export const issueListResponse = object(
  { items: array(issueSummaryResponse), pagination: paginationResponse },
  ['items'],
);
export const issueCommentListResponse = object({ items: array(issueCommentResponse) });
export const issueLabelListResponse = object({ items: array(issueLabelResponse) });

const pluginSettingValue = {
  anyOf: [string, integer, boolean, { type: 'array', items: string }, { type: 'null' }],
} as const;
export const pluginSettingResponse = object({
  key: string,
  type: string,
  title: string,
  configured: boolean,
  value: pluginSettingValue,
});
export const pluginSettingsResponse = object({ items: array(pluginSettingResponse) });
