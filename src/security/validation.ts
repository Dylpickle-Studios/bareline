import { posix } from 'node:path';

const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const reserved = new Set([
  'admin',
  'api',
  'assets',
  'docs',
  'login',
  'logout',
  'register',
  'settings',
]);

export function validateSlug(input: string, kind: 'username' | 'group' | 'repository'): string {
  const value = input.normalize('NFKC').toLowerCase();
  if (!slugPattern.test(value) || reserved.has(value) || value.endsWith('.git')) {
    throw new ValidationError(`Invalid ${kind} name`);
  }
  return value;
}

export function validateObjectId(value: string): string {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value))
    throw new ValidationError('Invalid object ID');
  return value;
}

export function validateRef(value: string): string {
  const components = value.split('/');
  if (
    value.length === 0 ||
    value.length > 255 ||
    value.startsWith('-') ||
    value.startsWith('.') ||
    value.startsWith('/') ||
    value === '@' ||
    value.includes('//') ||
    value.includes('..') ||
    value.includes('@{') ||
    containsForbiddenRefCharacter(value) ||
    value.endsWith('.') ||
    value.endsWith('/') ||
    components.some(
      (component) =>
        component.length === 0 || component.startsWith('.') || component.endsWith('.lock'),
    )
  ) {
    throw new ValidationError('Invalid Git reference');
  }
  return value;
}

function containsForbiddenRefCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || '~^:?*[\\'.includes(character)) return true;
  }
  return false;
}

export function validateRepoPath(value: string): string {
  if (
    value.length === 0 ||
    value.length > 4096 ||
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    containsForbiddenPathCharacter(value)
  ) {
    throw new ValidationError('Invalid repository path');
  }
  const normalized = posix.normalize(value);
  if (
    normalized !== value ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    value.split('/').some((component) => component === '.' || component === '..')
  ) {
    throw new ValidationError('Repository path escapes the repository');
  }
  return normalized;
}

function containsForbiddenPathCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export class ValidationError extends Error {
  readonly statusCode = 400;
}
