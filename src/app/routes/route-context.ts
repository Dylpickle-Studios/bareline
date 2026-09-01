import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AdminService } from '../../admin/admin-service.js';
import type { RuntimeSettingsService } from '../../admin/runtime-settings-service.js';
import type { AuditService } from '../../audit/audit-service.js';
import type { AuthService } from '../../auth/auth-service.js';
import type { ExternalAuthService } from '../../auth/external-auth-service.js';
import type { InviteService } from '../../auth/invite-service.js';
import type { PasskeyService } from '../../auth/passkey-service.js';
import type { RecoveryService } from '../../auth/recovery-service.js';
import type { TokenService, VerifiedToken } from '../../auth/token-service.js';
import type { TotpService } from '../../auth/totp-service.js';
import type { AppConfig } from '../../config/config.js';
import type { Database } from '../../database/database.js';
import type { ArchiveService } from '../../git/archive-service.js';
import type { GitBrowser } from '../../git/git-browser.js';
import type { GitRunner } from '../../git/git-runner.js';
import type { GroupService } from '../../groups/group-service.js';
import type { LfsService } from '../../lfs/lfs-service.js';
import type { MetricsRegistry } from '../../observability/metrics.js';
import type { PluginContributionService } from '../../plugins/contribution-service.js';
import type { PluginEventService } from '../../plugins/event-service.js';
import type { PluginManager } from '../../plugins/plugin-manager.js';
import type { IssueService } from '../../repositories/issue-service.js';
import type { ReleaseService } from '../../repositories/release-service.js';
import type { RepositoryAdminService } from '../../repositories/repository-admin-service.js';
import type { RepositoryEnhancementService } from '../../repositories/repository-enhancement-service.js';
import type { RepositoryMutationService } from '../../repositories/repository-mutation-service.js';
import type { RepositoryService } from '../../repositories/repository-service.js';
import type { SearchService } from '../../search/search-service.js';
import type { SshKeyService } from '../../ssh/ssh-key-service.js';
import type { AuthenticatedUser } from '../../auth/auth-service.js';
import type { WebhookService } from '../../webhooks/webhook-service.js';
import type { WikiService } from '../../repositories/wiki-service.js';

export interface Session {
  user: AuthenticatedUser;
  csrfToken: string;
}
export type Repository = ReturnType<RepositoryService['getById']>;

export interface AppRouteContext {
  app: FastifyInstance;
  config: AppConfig;
  database: Database;
  audit: AuditService;
  runtimeSettings: RuntimeSettingsService;
  auth: AuthService;
  tokens: TokenService;
  passkeys: PasskeyService;
  externalAuth: ExternalAuthService;
  recovery: RecoveryService;
  totp: TotpService;
  invites: InviteService;
  sshKeys: SshKeyService;
  git: GitRunner;
  repositories: RepositoryService;
  browser: GitBrowser;
  referenceOptions: (repository: Repository) => Promise<{
    branches: Awaited<ReturnType<GitBrowser['branches']>>;
    tags: Awaited<ReturnType<GitBrowser['tags']>>;
  }>;
  archives: ArchiveService;
  enhancements: RepositoryEnhancementService;
  issues: IssueService;
  releases: ReleaseService;
  wikis: WikiService;
  mutations: RepositoryMutationService;
  repositoryAdmin: RepositoryAdminService;
  groups: GroupService;
  search: SearchService;
  lfs: LfsService;
  pluginManager: PluginManager;
  pluginContributions: PluginContributionService;
  pluginEvents: PluginEventService;
  webhooks: WebhookService;
  administration: AdminService;
  metrics: MetricsRegistry;
  render: (view: string, data: Record<string, unknown>) => Promise<string>;
  session: (request: FastifyRequest) => Session | null;
  requireSession: (request: FastifyRequest) => Session;
  formCsrf: (request: FastifyRequest, reply: FastifyReply) => string;
  verifyFormCsrf: (request: FastifyRequest, supplied: string | undefined) => void;
  requireAdministrator: (request: FastifyRequest) => Session;
  pluginAdminPage: (current: Session) => Promise<string>;
  readableRepository: (request: FastifyRequest) => {
    repository: Repository;
    current: Session | null;
  };
  writableRepository: (request: FastifyRequest) => { repository: Repository; current: Session };
  gitPrincipal: (
    request: FastifyRequest,
    scope: 'repository:read' | 'repository:write',
  ) => VerifiedToken | null;
  apiPrincipal: (request: FastifyRequest, scope: string) => VerifiedToken | null;
  requireAdminPrincipal: (request: FastifyRequest) => VerifiedToken;
  apiRepository: (
    request: FastifyRequest,
    scope: 'repository:read' | 'repository:write',
    minimum: 'read' | 'write',
  ) => { repository: Repository; principal: VerifiedToken | null };
  gitAuthenticationRequired: (reply: FastifyReply) => FastifyReply;
  lfsRepository: (
    request: FastifyRequest,
    minimum: 'read' | 'write',
  ) => { repository: Repository; userId: number | null };
  withAuthorAvatar: <T extends { authorEmail: string }>(
    commit: T,
  ) => T & { avatarUrl: string | null };
  isClosing: () => boolean;
}
