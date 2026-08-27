import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface OutboundUrlRules {
  allowedHosts: readonly string[];
  protocols?: readonly string[];
  ports?: readonly number[];
  maxLength?: number;
}

const systemResolver: HostResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((item) => ({ address: item.address, family: item.family as 4 | 6 }));
};

/**
 * Validates destinations before a process or network client is allowed to use them.
 * The resolver is injectable so callers can test DNS rebinding and blocked ranges without
 * making network requests.
 */
export class OutboundPolicy {
  constructor(private readonly resolveHostname: HostResolver = systemResolver) {}

  validateUrl(input: string, rules: OutboundUrlRules): URL {
    const value = input.trim();
    if (value.length === 0 || value.length > (rules.maxLength ?? 2048) || /[\r\n\0]/.test(value))
      throw new OutboundPolicyError('Invalid outbound URL');
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new OutboundPolicyError('Outbound target must be a valid URL');
    }
    const protocol = url.protocol.toLowerCase();
    if (!(rules.protocols ?? ['https:']).includes(protocol))
      throw new OutboundPolicyError('Outbound URL scheme is not permitted');
    if (url.username || url.password)
      throw new OutboundPolicyError('Outbound URL must not contain credentials');
    const hostname = canonicalHostname(url.hostname);
    if (!hostname) throw new OutboundPolicyError('Outbound URL has an invalid hostname');
    if (!rules.allowedHosts.some((allowed) => canonicalHostname(allowed) === hostname))
      throw new OutboundPolicyError('Outbound host is not allowlisted');
    const defaultPort = protocol === 'https:' ? 443 : protocol === 'http:' ? 80 : undefined;
    const port = url.port ? Number(url.port) : defaultPort;
    if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new OutboundPolicyError('Outbound URL has an invalid port');
    if (rules.ports && !rules.ports.includes(port))
      throw new OutboundPolicyError('Outbound URL port is not permitted');
    if (isIP(hostname) !== 0 && isNonPublicAddress(hostname))
      throw new OutboundPolicyError('Outbound destination is a private or reserved address');
    return url;
  }

  async assertSafeUrl(input: string, rules: OutboundUrlRules): Promise<URL> {
    const url = this.validateUrl(input, rules);
    await this.assertSafeHostname(url.hostname);
    return url;
  }

  validateGitTarget(
    input: string,
    rules: Pick<OutboundUrlRules, 'allowedHosts' | 'maxLength'>,
  ): string {
    if (input.trim().startsWith('git@')) return this.validateSshTarget(input, rules.allowedHosts);
    return this.validateUrl(input, { ...rules, protocols: ['https:'], ports: [443] }).toString();
  }

  async assertSafeGitTarget(
    input: string,
    rules: Pick<OutboundUrlRules, 'allowedHosts' | 'maxLength'>,
  ): Promise<string> {
    if (input.trim().startsWith('git@')) {
      const target = this.validateSshTarget(input, rules.allowedHosts);
      const host = /^git@(?<host>[A-Za-z0-9.-]+):/.exec(target)?.groups?.host;
      if (!host) throw new OutboundPolicyError('Invalid SSH Git target');
      await this.assertSafeHostname(host);
      return target;
    }
    return (
      await this.assertSafeUrl(input, {
        ...rules,
        protocols: ['https:'],
        ports: [443],
      })
    ).toString();
  }

  private validateSshTarget(input: string, allowedHosts: readonly string[]): string {
    const value = input.trim();
    if (value.length > 2048 || /[\r\n\0]/.test(value))
      throw new OutboundPolicyError('Invalid SSH Git target');
    const match = /^git@(?<host>[A-Za-z0-9.-]+):(?<path>[A-Za-z0-9._/-]+)$/.exec(value);
    if (!match?.groups?.host || !match.groups.path || match.groups.path.startsWith('-'))
      throw new OutboundPolicyError('Invalid SSH Git target');
    const hostname = canonicalHostname(match.groups.host);
    if (!hostname) throw new OutboundPolicyError('Invalid SSH Git hostname');
    if (!allowedHosts.some((allowed) => canonicalHostname(allowed) === hostname))
      throw new OutboundPolicyError('Outbound host is not allowlisted');
    if (isIP(hostname) !== 0 && isNonPublicAddress(hostname))
      throw new OutboundPolicyError('Outbound destination is a private or reserved address');
    return value;
  }

  private async assertSafeHostname(input: string): Promise<void> {
    const hostname = canonicalHostname(input);
    if (!hostname) throw new OutboundPolicyError('Outbound URL has an invalid hostname');
    if (isIP(hostname) !== 0) {
      if (isNonPublicAddress(hostname))
        throw new OutboundPolicyError('Outbound destination is a private or reserved address');
      return;
    }
    let first: readonly ResolvedAddress[];
    let second: readonly ResolvedAddress[];
    try {
      // Resolve twice immediately before use. A public answer followed by a private answer is
      // treated as unsafe, which catches common DNS-rebinding responses at the policy boundary.
      first = await this.resolveHostname(hostname);
      second = await this.resolveHostname(hostname);
    } catch {
      throw new OutboundPolicyError('Outbound hostname could not be resolved');
    }
    const addresses = [...first, ...second];
    if (addresses.length === 0) throw new OutboundPolicyError('Outbound hostname has no address');
    for (const resolved of addresses) {
      const family = isIP(resolved.address);
      if (family === 0 || family !== resolved.family)
        throw new OutboundPolicyError('Outbound resolver returned an invalid address');
      if (isNonPublicAddress(resolved.address))
        throw new OutboundPolicyError(
          'Outbound hostname resolves to a private or reserved address',
        );
    }
  }
}

export function canonicalHostname(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (value.endsWith('.')) value = value.slice(0, -1);
  if (!value || /[%/\\:@?#]/.test(value)) return null;
  const addressFamily = isIP(value);
  if (addressFamily !== 0) return value;
  const ascii = domainToASCII(value).toLowerCase();
  if (
    !ascii ||
    ascii.length > 253 ||
    ascii.startsWith('.') ||
    ascii.endsWith('.') ||
    ascii.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return null;
  return ascii;
}

export function isNonPublicAddress(input: string): boolean {
  let value = input.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const family = isIP(value);
  if (family === 4) return isNonPublicIpv4(value);
  if (family !== 6) return true;
  const bytes = parseIpv6(value);
  if (!bytes) return true;
  const firstByte = bytes[0] ?? 0;
  const secondByte = bytes[1] ?? 0;
  const thirdByte = bytes[2] ?? 0;
  const fourthByte = bytes[3] ?? 0;
  const lastByte = bytes[15] ?? 0;
  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 255 && bytes[11] === 255;
  if (mapped) return isNonPublicIpv4(bytes.slice(12, 16).join('.'));
  return (
    bytes.every((byte) => byte === 0) ||
    (bytes.slice(0, 15).every((byte) => byte === 0) && lastByte === 1) ||
    firstByte === 0 ||
    (firstByte & 0xfe) === 0xfc ||
    (firstByte === 0xfe && (secondByte & 0xc0) === 0x80) ||
    firstByte === 0xff ||
    (firstByte === 0x20 && secondByte === 0x01 && thirdByte === 0x0d && fourthByte === 0xb8) ||
    (firstByte === 0x20 && secondByte === 0x01 && thirdByte === 0x00 && fourthByte === 0x00) ||
    (firstByte === 0x20 && secondByte === 0x01 && thirdByte === 0x00 && fourthByte === 0x02) ||
    (firstByte === 0x20 && secondByte === 0x01 && thirdByte === 0x00 && fourthByte === 0x10)
  );
}

function isNonPublicIpv4(value: string): boolean {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return true;
  const [first, second, third, fourth] = parts;
  if (first === undefined || second === undefined || third === undefined || fourth === undefined)
    return true;
  return (
    first === 0 ||
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function parseIpv6(value: string): number[] | null {
  if (value.includes('%')) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const leftValues = parseIpv6Parts(left);
  const rightValues = parseIpv6Parts(right);
  if (!leftValues || !rightValues) return null;
  const missing = 8 - leftValues.length - rightValues.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [...leftValues, ...new Array<number>(missing).fill(0), ...rightValues].flatMap((part) => [
    (part >> 8) & 0xff,
    part & 0xff,
  ]);
}

function parseIpv6Parts(parts: string[]): number[] | null {
  const values: number[] = [];
  for (const part of parts) {
    if (part.includes('.')) {
      const ipv4 = part.split('.').map(Number);
      if (
        ipv4.length !== 4 ||
        ipv4.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
      )
        return null;
      const [first, second, third, fourth] = ipv4;
      if (
        first === undefined ||
        second === undefined ||
        third === undefined ||
        fourth === undefined
      )
        return null;
      values.push(first * 256 + second, third * 256 + fourth);
    } else {
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
      values.push(Number.parseInt(part, 16));
    }
  }
  return values.length <= 8 ? values : null;
}

export class OutboundPolicyError extends Error {}
