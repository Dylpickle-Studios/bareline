export class GitError extends Error {
  constructor(
    message: string,
    readonly code: 'failed' | 'timeout' | 'output_limit' | 'cancelled' | 'not_found',
  ) {
    super(message);
  }
}
