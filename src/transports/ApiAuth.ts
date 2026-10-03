import type { TokenProvider } from '../types/auth.js';
import type { HttpRequest, HttpResponse } from './HttpClient.js';
import { httpRequest } from './HttpClient.js';
import { request } from './utils.js';

/**
 * Perform an authenticated API call with an OAuth `getToken` provider.
 * A 401 refreshes the token once (`invalid: true`) and retries the request.
 */
export async function authorizedRequest(
  provider: string,
  auth: { user: string; getToken: TokenProvider; protocol: 'graph' | 'gmail' },
  req: Omit<HttpRequest, 'headers'> & { headers?: Record<string, string> },
): Promise<HttpResponse> {
  const call = async (invalid: boolean) => {
    const token = await auth.getToken({ protocol: auth.protocol, user: auth.user, invalid });
    return request(provider, () => httpRequest({ ...req, headers: { ...req.headers, Authorization: `Bearer ${token}` } }));
  };
  const res = await call(false);
  return res.status === 401 ? call(true) : res;
}
