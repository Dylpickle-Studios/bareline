export interface LfsPointer {
  objectId: string;
  size: number;
}

export function parseLfsPointer(content: Buffer): LfsPointer | null {
  if (content.length > 4096 || content.includes(0)) return null;
  const lines = content.toString('utf8').trimEnd().split('\n');
  if (lines[0] !== 'version https://git-lfs.github.com/spec/v1') return null;
  const oid = lines.find((line) => line.startsWith('oid sha256:'))?.slice('oid sha256:'.length);
  const sizeText = lines.find((line) => line.startsWith('size '))?.slice(5);
  if (!oid || !/^[0-9a-f]{64}$/.test(oid) || !sizeText || !/^\d+$/.test(sizeText)) return null;
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0) return null;
  return { objectId: oid, size };
}
