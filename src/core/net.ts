/** `true` for hosts that never leave the machine (local test servers, mail bridges). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h) || h.endsWith('.localhost');
}

/** Resolve the `requireTLS` default: on, except for loopback hosts. */
export function resolveRequireTLS(explicit: boolean | undefined, host: string): boolean {
  return explicit ?? !isLoopbackHost(host);
}
