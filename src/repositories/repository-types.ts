export type OwnerType = 'user' | 'group';
export type Visibility = 'public' | 'private';

export type RepositoryEventPublisher = (
  event:
    | 'repository.created'
    | 'repository.deleted'
    | 'repository.renamed'
    | 'repository.visibilityChanged'
    | 'repository.forked'
    | 'branch.created'
    | 'branch.deleted'
    | 'branch.merged'
    | 'tag.created'
    | 'tag.deleted'
    | 'release.created'
    | 'release.deleted'
    | 'commit.createdViaWeb'
    | 'commit.cherryPickedViaWeb'
    | 'commit.revertedViaWeb'
    | 'patch.importedViaWeb'
    | 'wiki.pageUpdatedViaWeb',
  payload: Readonly<Record<string, unknown>>,
) => void;
export type StorageKind = 'hosted_bare' | 'imported_bare' | 'working_tree';
export type Permission = 'none' | 'read' | 'write' | 'admin' | 'owner';

export interface Repository {
  id: number;
  ownerType: OwnerType;
  ownerId: number;
  ownerSlug: string;
  slug: string;
  description: string;
  visibility: Visibility;
  storageId: string;
  storageKind: StorageKind;
  storagePath: string | null;
  defaultBranch: string;
  /** ISO-8601 timestamp when writes were disabled, or null while active. */
  archivedAt: string | null;
  /** Id of the repository this one was forked from, or null if it is not a fork. */
  forkedFromId: number | null;
}

export interface RepositoryHealthReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checkedAt: string;
  archived: boolean;
  defaultBranch: { name: string; exists: boolean };
  refs: { branches: number; tags: number };
  objects: { count: number | null; size: string | null; packs: number | null };
  issues: readonly string[];
}

export interface TreeEntry {
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  objectId: string;
  size: number | null;
  name: string;
  submoduleUrl?: string;
  submoduleLink?: string;
}
