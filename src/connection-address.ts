const REMOTE_CONNECT = 'connect.loxonecloud.com';
const LEGACY_CLOUD_DNS = 'dns.loxonecloud.com';

export function parseMiniserverSerial(value: string): string | null {
  const trimmed = value.trim();
  if (!/^[\da-f]{12}$/i.test(trimmed) &&
      !/^[\da-f]{2}(?::[\da-f]{2}){5}$/i.test(trimmed) &&
      !/^[\da-f]{2}(?:-[\da-f]{2}){5}$/i.test(trimmed)) {
    return null;
  }
  return trimmed.replace(/[:-]/g, '').toUpperCase();
}

export function parseConnectionAddress(value: string): URL | null {
  const input = value.trim();
  if (!input) {
    return null;
  }
  const serial = parseMiniserverSerial(input);
  if (serial) {
    return new URL(`https://${REMOTE_CONNECT}/${serial}`);
  }

  try {
    const explicitProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(input);
    const url = new URL(explicitProtocol ? input : `https://${input}`);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return null;
    }
    if (isCloudDnsHost(url.hostname)) {
      url.protocol = 'https:';
    } else if (!explicitProtocol && isLocalHost(url.hostname)) {
      url.protocol = 'http:';
    }
    return url;
  } catch {
    return null;
  }
}

export function remoteConnectSerial(address: URL | null): string | null {
  if (address?.hostname !== REMOTE_CONNECT && address?.hostname !== LEGACY_CLOUD_DNS) {
    return null;
  }
  const serial = address.pathname.split('/').filter(Boolean)[0] ?? '';
  return /^[a-z\d]+$/i.test(serial) ? serial.toUpperCase() : null;
}

export function remoteConnectUrl(serial: string): string {
  return `https://${REMOTE_CONNECT}/${encodeURIComponent(serial)}`;
}

function isCloudDnsHost(hostname: string): boolean {
  return hostname === REMOTE_CONNECT || hostname === LEGACY_CLOUD_DNS ||
    hostname.endsWith('.dyndns.loxonecloud.com');
}

export function isLocalHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  const cloudAlias = /^(\d{1,3}(?:-\d{1,3}){3})\.[a-z\d]+\.dyndns\.loxonecloud\.com$/.exec(lower);
  const candidate = cloudAlias ? cloudAlias[1].replace(/-/g, '.') : lower;
  if (candidate === 'localhost' || candidate === '[::1]' || candidate.endsWith('.local') ||
      /^\[(?:f[cd][\da-f]{2}|fe[89ab][\da-f]):/i.test(candidate)) {
    return true;
  }
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate)) {
    return false;
  }
  const [a, b] = candidate.split('.').map(Number);
  return a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
