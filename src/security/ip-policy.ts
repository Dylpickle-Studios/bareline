import { isIP } from 'node:net';

interface ParsedAddress {
  readonly family: 4 | 6;
  readonly bytes: Uint8Array;
}

/** Match a peer address against literal addresses and CIDR ranges. */
export function isAddressAllowed(address: string, rules: readonly string[]): boolean {
  const candidate = parseAddress(address);
  if (!candidate) return false;
  return rules.some((rule) => matchesRule(candidate, rule));
}

function matchesRule(candidate: ParsedAddress, rule: string): boolean {
  const slash = rule.indexOf('/');
  const address = slash === -1 ? rule : rule.slice(0, slash);
  const network = parseAddress(address);
  if (network?.family !== candidate.family) return false;
  const prefix = slash === -1 ? network.bytes.length * 8 : Number(rule.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > network.bytes.length * 8) return false;
  const wholeBytes = Math.floor(prefix / 8);
  const remainingBits = prefix % 8;
  for (let index = 0; index < wholeBytes; index += 1) {
    if (candidate.bytes[index] !== network.bytes[index]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = 0xff << (8 - remainingBits);
  return ((candidate.bytes[wholeBytes] ?? 0) & mask) === ((network.bytes[wholeBytes] ?? 0) & mask);
}

function parseAddress(value: string): ParsedAddress | null {
  const family = isIP(value);
  if (family === 4) {
    const octets = value.split('.').map(Number);
    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    )
      return null;
    return { family: 4, bytes: Uint8Array.from(octets) };
  }
  if (family !== 6 || value.includes('%')) return null;
  const groups = expandIpv6(value);
  if (!groups) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return { family: 6, bytes };
}

function expandIpv6(value: string): number[] | null {
  let normalized = value;
  const dotted = value.lastIndexOf('.');
  if (dotted !== -1) {
    const colon = value.lastIndexOf(':');
    if (colon === -1) return null;
    const octets = value
      .slice(colon + 1)
      .split('.')
      .map(Number);
    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    )
      return null;
    normalized = `${value.slice(0, colon)}:${(((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16)}:${(((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = parseGroups(halves[0] ?? '');
  const right = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
  if (!left || !right || left.length + right.length > 8) return null;
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (halves.length === 1 && left.length !== 8) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function parseGroups(value: string): number[] | null {
  if (!value) return [];
  const groups = value.split(':');
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}
