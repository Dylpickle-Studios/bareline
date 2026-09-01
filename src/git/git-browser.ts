import type { AppConfig } from '../config/config.js';
import type { RepositoryService } from '../repositories/repository-service.js';
import type { Repository } from '../repositories/repository-types.js';
import { validateObjectId, validateRef, validateRepoPath } from '../security/validation.js';
import { computeLanguageStats, type LanguageStat } from './language-stats.js';
import type { GitRunner } from './git-runner.js';

export interface ContributorStat {
  name: string;
  email: string;
  commits: number;
}

export interface CommitSummary {
  objectId: string;
  shortId: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
}

export interface RefSummary {
  name: string;
  objectId: string;
  subject: string;
  committedAt: string;
  signature: SignatureInfo | null;
}

export interface CommitDetail extends CommitSummary {
  treeId: string;
  message: string;
  committerName: string;
  committedAt: string;
  parents: string[];
  additions: number;
  deletions: number;
  filesChanged: number;
  diff: string;
  truncated: boolean;
  diffFiles: DiffFile[];
  signature: SignatureInfo;
}

export interface SignatureInfo {
  state: 'unsigned' | 'valid' | 'invalid' | 'unknown' | 'error';
  label: string;
  signer: string | null;
  keyId: string | null;
  fingerprint: string | null;
  identityTrusted: boolean;
}

export interface Comparison {
  base: string;
  head: string;
  mergeBase: string;
  commits: CommitSummary[];
  additions: number;
  deletions: number;
  filesChanged: number;
  diff: string;
  truncated: boolean;
  diffFiles: DiffFile[];
}

export interface DiffHunk {
  header: string;
  anchor: string;
  lines: string[];
}
export interface DiffFile {
  oldPath: string;
  newPath: string;
  anchor: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'binary';
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
  hunks: DiffHunk[];
}

export interface BlameLine {
  lineNumber: number;
  objectId: string;
  author: string;
  authoredAt: string;
  content: string;
}

export class GitBrowser {
  constructor(
    private readonly git: GitRunner,
    private readonly repositories: RepositoryService,
    private readonly config: AppConfig,
  ) {}

  async commits(
    repository: Repository,
    ref: string,
    page = 1,
    pageSize = 30,
  ): Promise<CommitSummary[]> {
    validateRef(ref);
    const path = await this.repositories.storagePath(repository);
    const offset = Math.max(0, page - 1) * pageSize;
    const result = await this.git.run([
      '--git-dir',
      path,
      'log',
      `--max-count=${String(Math.min(pageSize, 100))}`,
      `--skip=${String(offset)}`,
      '--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00',
      '--end-of-options',
      ref,
    ]);
    return parseCommits(result.stdout);
  }

  async fileHistory(
    repository: Repository,
    ref: string,
    file: string,
    page = 1,
    pageSize = 30,
  ): Promise<CommitSummary[]> {
    validateRef(ref);
    const safeFile = validateRepoPath(file);
    const path = await this.repositories.storagePath(repository);
    const offset = Math.max(0, page - 1) * pageSize;
    const result = await this.git.run([
      '--git-dir',
      path,
      'log',
      `--max-count=${String(Math.min(pageSize, 100))}`,
      `--skip=${String(offset)}`,
      '--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00',
      '--end-of-options',
      ref,
      '--',
      safeFile,
    ]);
    return parseCommits(result.stdout);
  }

  async branches(repository: Repository): Promise<RefSummary[]> {
    return await this.refs(repository, 'refs/heads');
  }

  async tags(repository: Repository): Promise<RefSummary[]> {
    return await this.refs(repository, 'refs/tags');
  }

  async commit(
    repository: Repository,
    objectIdInput: string,
    limits?: { lineLimit?: number; byteLimit?: number },
  ): Promise<CommitDetail> {
    const objectId = validateObjectId(objectIdInput);
    const path = await this.repositories.storagePath(repository);
    const metadata = await this.git.run([
      '--git-dir',
      path,
      'show',
      '--no-patch',
      '--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00%cn%x00%cI%x00%P%x00%T%x00%G?%x00%GS%x00%GK%x00%GF%x00%B',
      '--end-of-options',
      objectId,
    ]);
    const fields = metadata.stdout.toString('utf8').split('\0');
    if (fields.length < 15) throw new Error('Git returned invalid commit metadata');
    const diff = await this.git.run(
      [
        '--git-dir',
        path,
        'show',
        '--format=',
        '--find-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--unified=3',
        '--end-of-options',
        objectId,
      ],
      {
        maxOutputBytes: Math.min(
          limits?.byteLimit ?? this.config.limits.diffBytes,
          this.config.limits.diffBytes,
        ),
        truncateOutput: true,
      },
    );
    const stats = countDiff(
      diff.stdout.toString('utf8'),
      Math.min(limits?.lineLimit ?? this.config.limits.diffLines, this.config.limits.diffLines),
    );
    return {
      objectId: validateObjectId(fields[0] ?? ''),
      shortId: fields[1] ?? '',
      authorName: fields[2] ?? '',
      authorEmail: fields[3] ?? '',
      authoredAt: fields[4] ?? '',
      subject: fields[5] ?? '',
      committerName: fields[6] ?? '',
      committedAt: fields[7] ?? '',
      parents: (fields[8] ?? '').split(' ').filter(Boolean).map(validateObjectId),
      treeId: validateObjectId(fields[9] ?? ''),
      signature: signatureInfo(fields[10] ?? 'N', fields[11], fields[12], fields[13]),
      message: fields.slice(14).join('\0').trim(),
      additions: stats.additions,
      deletions: stats.deletions,
      filesChanged: stats.filesChanged,
      diff: stats.text,
      truncated: stats.truncated || diff.truncated,
      diffFiles: parseDiffFiles(
        stats.text,
        this.config.limits.diffFiles,
        this.config.limits.diffFileBytes,
      ),
    };
  }

  async compare(repository: Repository, baseInput: string, headInput: string): Promise<Comparison> {
    validateRef(baseInput);
    validateRef(headInput);
    const path = await this.repositories.storagePath(repository);
    const [base, head] = await Promise.all([
      this.repositories.resolveCommit(repository, baseInput),
      this.repositories.resolveCommit(repository, headInput),
    ]);
    const mergeBaseResult = await this.git.run(['--git-dir', path, 'merge-base', base, head]);
    const mergeBase = validateObjectId(mergeBaseResult.stdout.toString('ascii').trim());
    const commitResult = await this.git.run([
      '--git-dir',
      path,
      'log',
      '--max-count=100',
      '--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00',
      `${base}..${head}`,
    ]);
    const diffResult = await this.git.run(
      [
        '--git-dir',
        path,
        'diff',
        '--find-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--unified=3',
        mergeBase,
        head,
        '--',
      ],
      { maxOutputBytes: this.config.limits.diffBytes, truncateOutput: true },
    );
    const stats = countDiff(diffResult.stdout.toString('utf8'), this.config.limits.diffLines);
    return {
      base,
      head,
      mergeBase,
      commits: parseCommits(commitResult.stdout),
      additions: stats.additions,
      deletions: stats.deletions,
      filesChanged: stats.filesChanged,
      diff: stats.text,
      truncated: stats.truncated || diffResult.truncated,
      diffFiles: parseDiffFiles(
        stats.text,
        this.config.limits.diffFiles,
        this.config.limits.diffFileBytes,
      ),
    };
  }

  /** Renders a single commit as a `git format-patch` mail, suitable for `git am`. */
  async commitPatch(repository: Repository, objectIdInput: string): Promise<string> {
    const objectId = validateObjectId(objectIdInput);
    const path = await this.repositories.storagePath(repository);
    const result = await this.git.run(
      [
        '--git-dir',
        path,
        'format-patch',
        '--stdout',
        '--find-renames',
        '--no-ext-diff',
        '--no-textconv',
        '-1',
        '--end-of-options',
        objectId,
      ],
      { maxOutputBytes: this.config.limits.diffBytes },
    );
    return result.stdout.toString('utf8');
  }

  /** Renders every commit reachable from `head` but not `base` as a `git format-patch` series. */
  async comparePatch(
    repository: Repository,
    baseInput: string,
    headInput: string,
  ): Promise<string> {
    validateRef(baseInput);
    validateRef(headInput);
    const path = await this.repositories.storagePath(repository);
    const [base, head] = await Promise.all([
      this.repositories.resolveCommit(repository, baseInput),
      this.repositories.resolveCommit(repository, headInput),
    ]);
    const mergeBaseResult = await this.git.run(['--git-dir', path, 'merge-base', base, head]);
    const mergeBase = validateObjectId(mergeBaseResult.stdout.toString('ascii').trim());
    const result = await this.git.run(
      [
        '--git-dir',
        path,
        'format-patch',
        '--stdout',
        '--find-renames',
        '--no-ext-diff',
        '--no-textconv',
        `${mergeBase}..${head}`,
      ],
      { maxOutputBytes: this.config.limits.diffBytes },
    );
    return result.stdout.toString('utf8');
  }

  /** Approximate per-language byte breakdown of a ref's tree, GitHub-linguist-style. */
  async languageStats(repository: Repository, ref: string): Promise<LanguageStat[]> {
    validateRef(ref);
    const commit = await this.repositories.resolveCommit(repository, ref);
    const path = await this.repositories.storagePath(repository);
    const result = await this.git.run(
      ['--git-dir', path, 'ls-tree', '-r', '-l', '-z', '--end-of-options', commit],
      { maxOutputBytes: this.config.limits.gitOutputBytes },
    );
    const entries: { path: string; size: number }[] = [];
    for (const entry of result.stdout.toString('utf8').split('\0')) {
      if (!entry) continue;
      const tabIndex = entry.indexOf('\t');
      if (tabIndex < 0) continue;
      const metadata = entry.slice(0, tabIndex).trim().split(/\s+/);
      const size = Number.parseInt(metadata[3] ?? '', 10);
      const filePath = entry.slice(tabIndex + 1);
      if (metadata[1] === 'blob' && Number.isFinite(size)) entries.push({ path: filePath, size });
    }
    return computeLanguageStats(entries);
  }

  /** Commit counts per author across the whole ref, most active first. */
  async contributors(repository: Repository, ref: string): Promise<ContributorStat[]> {
    validateRef(ref);
    const path = await this.repositories.storagePath(repository);
    const result = await this.git.run([
      '--git-dir',
      path,
      'shortlog',
      '-sne',
      '--end-of-options',
      ref,
    ]);
    const contributors: ContributorStat[] = [];
    for (const line of result.stdout.toString('utf8').split('\n')) {
      const match = /^\s*(\d+)\t(.*) <(.*)>\s*$/.exec(line);
      if (!match) continue;
      contributors.push({
        name: match[2] ?? '',
        email: match[3] ?? '',
        commits: Number.parseInt(match[1] ?? '0', 10),
      });
    }
    return contributors;
  }

  async blame(repository: Repository, ref: string, file: string): Promise<BlameLine[]> {
    validateRef(ref);
    const safeFile = validateRepoPath(file);
    const commit = await this.repositories.resolveCommit(repository, ref);
    const path = await this.repositories.storagePath(repository);
    const result = await this.git.run(
      ['--git-dir', path, 'blame', '--line-porcelain', commit, '--', safeFile],
      { timeoutMs: this.config.git.timeoutMs, maxOutputBytes: this.config.limits.gitOutputBytes },
    );
    return parseBlame(result.stdout.toString('utf8'));
  }

  private async refs(repository: Repository, prefix: string): Promise<RefSummary[]> {
    const path = await this.repositories.storagePath(repository);
    const result = await this.git.run([
      '--git-dir',
      path,
      'for-each-ref',
      '--sort=-committerdate',
      '--count=500',
      '--format=%(refname:short)%00%(objectname)%00%(*objectname)%00%(subject)%00%(creatordate:iso-strict)%00%(contents:signature)%00',
      prefix,
    ]);
    const fields = result.stdout.toString('utf8').split('\0');
    const references: RefSummary[] = [];
    let verifiedTags = 0;
    for (let index = 0; index + 5 < fields.length; index += 6) {
      const name = fields[index]?.trim();
      if (!name) continue;
      const tagObjectId = validateObjectId(fields[index + 1] ?? '');
      const peeled = fields[index + 2]?.trim() ?? '';
      const signaturePresent = (fields[index + 5]?.trim().length ?? 0) > 0;
      let signature: SignatureInfo | null = null;
      if (prefix === 'refs/tags') {
        if (!signaturePresent) signature = signatureInfo('N');
        else if (verifiedTags < 50) {
          signature = await this.verifyTagSignature(path, tagObjectId);
          verifiedTags += 1;
        } else signature = signatureInfo('?');
      }
      references.push({
        name,
        objectId: validateObjectId(peeled === '' ? tagObjectId : peeled),
        subject: fields[index + 3] ?? '',
        committedAt: fields[index + 4] ?? '',
        signature,
      });
    }
    return references;
  }

  private async verifyTagSignature(
    repositoryPath: string,
    tagObjectId: string,
  ): Promise<SignatureInfo> {
    const result = await this.git.run(
      ['--git-dir', repositoryPath, 'verify-tag', '--raw', '--end-of-options', tagObjectId],
      { acceptedExitCodes: [0, 1, 2, 128], maxOutputBytes: 64 * 1024 },
    );
    return tagVerificationInfo(result.exitCode, result.stderr);
  }
}

export function tagVerificationInfo(exitCode: number, diagnostic: string): SignatureInfo {
  const valid = /\[GNUPG:\] VALIDSIG ([0-9A-F]+)/.exec(diagnostic);
  const good = /\[GNUPG:\] GOODSIG ([0-9A-F]+) ([^\r\n]+)/.exec(diagnostic);
  if (exitCode === 0) {
    return signatureInfo('G', good?.[2], good?.[1], valid?.[1]);
  }
  if (/\[GNUPG:\] (?:BADSIG|EXPKEYSIG|REVKEYSIG|EXPSIG)/.test(diagnostic))
    return signatureInfo('B', good?.[2], good?.[1], valid?.[1]);
  if (
    diagnostic.includes('[GNUPG:] NO_PUBKEY') ||
    /unknown key|No principal matched/i.test(diagnostic)
  )
    return signatureInfo('?');
  return signatureInfo('E');
}

export function signatureInfo(
  code: string,
  signer?: string,
  keyId?: string,
  fingerprint?: string,
): SignatureInfo {
  const state: SignatureInfo['state'] =
    code === 'N'
      ? 'unsigned'
      : code === 'G' || code === 'U'
        ? 'valid'
        : code === 'B' || code === 'R' || code === 'X' || code === 'Y'
          ? 'invalid'
          : code === 'E'
            ? 'error'
            : 'unknown';
  const labels: Record<SignatureInfo['state'], string> = {
    unsigned: 'Unsigned',
    valid: 'Cryptographically valid; identity not trusted by this server',
    invalid: 'Invalid or no longer valid signature',
    unknown: 'Signature present; verification key unavailable',
    error: 'Signature verification failed',
  };
  const value = (input?: string): string | null => {
    const trimmed = input?.trim();
    return trimmed === undefined || trimmed === '' ? null : trimmed;
  };
  return {
    state,
    label: labels[state],
    signer: value(signer),
    keyId: value(keyId),
    fingerprint: value(fingerprint),
    identityTrusted: false,
  };
}

function parseCommits(output: Buffer): CommitSummary[] {
  const fields = output.toString('utf8').split('\0');
  const commits: CommitSummary[] = [];
  for (let index = 0; index + 5 < fields.length; index += 6) {
    const objectId = fields[index]?.trim();
    if (!objectId) continue;
    commits.push({
      objectId: validateObjectId(objectId),
      shortId: fields[index + 1] ?? '',
      authorName: fields[index + 2] ?? '',
      authorEmail: fields[index + 3] ?? '',
      authoredAt: fields[index + 4] ?? '',
      subject: fields[index + 5] ?? '',
    });
  }
  return commits;
}

function countDiff(value: string, lineLimit: number) {
  const lines = value.split('\n');
  const shown = lines.slice(0, lineLimit);
  let additions = 0;
  let deletions = 0;
  let filesChanged = 0;
  for (const line of shown) {
    if (line.startsWith('diff --git ')) filesChanged += 1;
    else if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return {
    additions,
    deletions,
    filesChanged,
    text: shown.join('\n'),
    truncated: lines.length > shown.length,
  };
}

export function parseDiffFiles(
  value: string,
  fileLimit = 500,
  fileByteLimit = 2 * 1024 * 1024,
): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let currentBytes = 0;
  for (const line of value.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header?.[1] && header[2]) {
      if (files.length >= fileLimit) break;
      current = {
        oldPath: header[1],
        newPath: header[2],
        anchor: `diff-${anchorFor(header[2])}`,
        status: 'modified',
        additions: 0,
        deletions: 0,
        binary: false,
        truncated: false,
        hunks: [],
      };
      files.push(current);
      hunk = null;
      currentBytes = Buffer.byteLength(line, 'utf8') + 1;
      continue;
    }
    if (!current) continue;
    currentBytes += Buffer.byteLength(line, 'utf8') + 1;
    if (currentBytes > fileByteLimit) {
      current.truncated = true;
      hunk = null;
      continue;
    }
    if (line.startsWith('new file mode ')) current.status = 'added';
    else if (line.startsWith('deleted file mode ')) current.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      current.status = 'renamed';
      current.oldPath = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) current.newPath = line.slice('rename to '.length);
    else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.binary = true;
      if (current.status === 'modified') current.status = 'binary';
    } else if (line.startsWith('@@')) {
      hunk = {
        header: line,
        anchor: `${current.anchor}-hunk-${String(current.hunks.length + 1)}`,
        lines: [],
      };
      current.hunks.push(hunk);
    } else if (hunk) {
      hunk.lines.push(line);
      if (line.startsWith('+') && !line.startsWith('+++')) current.additions += 1;
      else if (line.startsWith('-') && !line.startsWith('---')) current.deletions += 1;
    }
  }
  return files;
}

function anchorFor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url').slice(0, 120);
}

function parseBlame(value: string): BlameLine[] {
  const lines = value.split('\n');
  const output: BlameLine[] = [];
  let objectId = '';
  let lineNumber = 0;
  let author = 'Unknown';
  let authoredAt = '';
  for (const line of lines) {
    const header = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(line);
    if (header?.[1] && header[2]) {
      objectId = validateObjectId(header[1]);
      lineNumber = Number(header[2]);
    } else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('author-time ')) {
      authoredAt = new Date(Number(line.slice(12)) * 1000).toISOString();
    } else if (line.startsWith('\t')) {
      output.push({ objectId, lineNumber, author, authoredAt, content: line.slice(1) });
    }
  }
  return output;
}
