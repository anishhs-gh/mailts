/**
 * `@mailts/core/oauth` — OAuth 2.0 for Gmail / Google Workspace and
 * Microsoft 365 / Outlook.com. Zero dependencies.
 *
 * - `authorizeWithLoopback()` — browser sign-in for CLIs and desktop apps
 * - `buildAuthorizationUrl()` + `exchangeCode()` — web redirect flow
 * - `googleTokenProvider()` / `microsoftTokenProvider()` — `getToken` for
 *   `auth: { type: 'xoauth2', user, getToken }` with caching, refresh and rotation
 * - `mailConfigFor()` — IMAP + SMTP configs for a provider
 */
export { google, microsoft, mailConfigFor } from './providers.js';
export type { OAuthProvider, MicrosoftOptions } from './providers.js';
export {
  createPkce,
  createState,
  buildAuthorizationUrl,
  exchangeCode,
  refreshAccessToken,
  createTokenProvider,
  googleTokenProvider,
  microsoftTokenProvider,
  emailFromIdToken,
} from './OAuthClient.js';
export type {
  TokenSet,
  Pkce,
  ClientCredentials,
  AuthorizationUrlOptions,
  ExchangeCodeOptions,
  RefreshOptions,
  TokenProviderOptions,
} from './OAuthClient.js';
export { authorizeWithLoopback, openBrowser } from './loopback.js';
export type { LoopbackOptions } from './loopback.js';
export type { TokenProvider, TokenContext } from '../types/auth.js';
export { OAuthError } from '../errors.js';
