export type OwnerType = 'user' | 'group';
export type Visibility = 'public' | 'private';

export type RepositoryEventPublisher = (
  event:
    | 'repository.created'
    | 'repository.deleted'
    | 'repository.renamed'
    | 'repository.visibilityChanged'
    | 'branch.created'
    | 'branch.deleted'
    | 'tag.created'
    | 'tag.deleted'
    | 'commit.createdViaWeb',
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
