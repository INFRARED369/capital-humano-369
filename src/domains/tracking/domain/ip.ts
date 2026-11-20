/** R5 · IP completa ≤ 7 días; después se trunca (IPv4 /24, IPv6 /48). Puro. */
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HEXTET = /^[0-9a-f]{1,4}$/i;

function expandirIpv6(ip: string): number[] | null {
  const partes = ip.split('::');
  if (partes.length > 2) return null;
  const parse = (s: string) => (s === '' ? [] : s.split(':'));
  const izq = parse(partes[0]!);
  const der = partes.length === 2 ? parse(partes[1]!) : [];
  if (![...izq, ...der].every((h) => HEXTET.test(h))) return null;
  const faltan = 8 - izq.length - der.length;
  if (partes.length === 1 ? faltan !== 0 : faltan < 1) return null;
  return [...izq, ...Array<string>(partes.length === 2 ? faltan : 0).fill('0'), ...der].map((h) => parseInt(h, 16));
}

const comprimir = (hextets: number[]): string => {
  const sig = hextets.slice(0, 3).map((h) => h.toString(16));
  while (sig.length && sig[sig.length - 1] === '0') sig.pop();
  return `${sig.join(':')}::`;
};

export function esIpValida(ip: string): boolean {
  if (IPV4.test(ip)) return true;
  if (/^::ffff:/i.test(ip) && IPV4.test(ip.slice(7))) return true;
  return expandirIpv6(ip) !== null;
}

export function truncarIp(ip: string): string | null {
  const v4 = /^::ffff:/i.test(ip) ? ip.slice(7) : ip;
  if (IPV4.test(v4)) return `${v4.split('.').slice(0, 3).join('.')}.0`;
  const hextets = expandirIpv6(ip);
  return hextets ? comprimir(hextets) : null;
}
