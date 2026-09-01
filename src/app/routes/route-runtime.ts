import type { AppConfig } from '../../config/config.js';

export { CsrfError } from '../../auth/auth-service.js';
export type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
export type { RuntimeSettings } from '../../admin/runtime-settings-service.js';
export { BackupDestinationService } from '../../backup/backup-destination-service.js';
export {
  administrationSystemResponse,
  appearanceResponse,
  blameResponse,
  blobResponse,
  collaboratorListResponse,
  commitDetailResponse,
  commitListResponse,
  comparisonResponse,
  groupListResponse,
  groupResponse,
  idResponse,
  inviteCreatedResponse,
  inviteListResponse,
  issueCommentListResponse,
  issueCommentResponse,
  issueLabelListResponse,
  issueLabelResponse,
  issueListResponse,
  issueResponse,
  objectIdResponse,
  okResponse,
  paginatedAdminRepositoriesResponse,
  paginatedAdminUsersResponse,
  paginatedAuditResponse,
  passkeyAuthenticationOptionsResponse,
  passkeyAuthenticationResultResponse,
  passkeyListResponse,
  passkeyRegistrationOptionsResponse,
  paletteResponse,
  pluginListResponse,
  pluginResponse,
  pluginSettingsResponse,
  profileResponse,
  progressiveDiffResponse,
  rebuildResponse,
  refListResponse,
  repositoryListResponse,
  repositoryResponse,
  repositoryTransferListResponse,
  runtimeSettingsResponse,
  searchResponse,
  searchStatusResponse,
  sessionListResponse,
  sshKeyListResponse,
  sshKeyResponse,
  tokenCreatedResponse,
  tokenListResponse,
  treeResponse,
  userResponse,
} from '../../api/openapi-schemas.js';
export { documentation, documentationPage, documentationSearch } from '../../docs/documentation.js';
export { llmsTxt } from '../../docs/llms-txt.js';
export { GitError } from '../../git/errors.js';
export { atomFeed } from '../../feeds/atom.js';
export type { LfsBatchObject } from '../../lfs/lfs-service.js';
export { parseLfsPointer } from '../../lfs/lfs-pointer.js';
export { examplePluginArchive } from '../../plugins/example-download.js';
export { PluginManager } from '../../plugins/plugin-manager.js';
export type { RepositoryService } from '../../repositories/repository-service.js';
export type { Visibility } from '../../repositories/repository-types.js';
export {
  AuthorizationError,
  NotFoundError,
  PayloadTooLargeError,
} from '../../repositories/repository-service.js';
export { serveSmartHttp } from '../../http-git/smart-http.js';
export { ValidationError } from '../../security/validation.js';
export {
  breadcrumbs,
  imageMetadata,
  isBinary,
  isMarkdown,
  isSafeImage,
  safeInlineMime,
} from '../../web/file-presentation.js';
export { renderMarkdown } from '../../web/markdown.js';
export { highlightSource } from '../../web/syntax.js';
export { product } from '../metadata.js';

export type FormBody = Record<string, string | undefined>;

export function cookieOptions(config: AppConfig, httpOnly: boolean) {
  return {
    path: '/',
    httpOnly,
    sameSite: 'lax' as const,
    secure: config.server.publicUrl.startsWith('https://'),
  };
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && (error as { statusCode?: number }).statusCode && error.message)
    return error.message;
  return 'The operation could not be completed.';
}
