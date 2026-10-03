<!-- Generated from README.md by scripts/build-skill.mjs — do not edit by hand. -->

# OAuth with mailts

Google and Microsoft sign-in, token providers and refresh-token rotation, scopes, service accounts and app-only access (`@mailts/core/oauth`).

## OAuth (Google & Microsoft)

Password login is disabled for most Microsoft 365 tenants and discouraged by Google. Use XOAUTH2 with a
`getToken` provider — it is called on every (re)connect, and once more with `invalid: true` when the server
rejects a token, so expired tokens are refreshed transparently.

```ts
import { MailTs } from '@mailts/core';
import { google, microsoft, googleTokenProvider, mailConfigFor } from '@mailts/core/oauth';

const getToken = googleTokenProvider({
  clientId: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  refreshToken: await keychain.get('refresh-token'),
});

const mail = new MailTs(mailConfigFor(google, { user: 'me@gmail.com', getToken }));
```

**Signing in (CLI / desktop)** — opens the browser, receives the redirect on `127.0.0.1`, exchanges the code with PKCE:

```ts
import { authorizeWithLoopback, microsoft, microsoftTokenProvider } from '@mailts/core/oauth';

const tokens = await authorizeWithLoopback({
  provider: microsoft(),                       // tenant: 'common' | 'organizations' | 'consumers' | <id>
  clientId: process.env.MS_CLIENT_ID!,
  onAuthUrl: (url) => { process.stderr.write(`Open ${url}\n`); },   // also opens the browser by default
});
await keychain.set('refresh-token', tokens.refreshToken!);

const getToken = microsoftTokenProvider({
  clientId: process.env.MS_CLIENT_ID!,
  refreshToken: tokens.refreshToken!,
  onRefreshToken: (rt) => keychain.set('refresh-token', rt),   // Microsoft rotates refresh tokens
});
```

**Web apps / backends** use the same pieces with their own redirect: `createPkce()`, `createState()`,
`buildAuthorizationUrl()`, then `exchangeCode()` in the callback; store the refresh token (encrypted) per user and
build a `createTokenProvider()` when you need the mailbox. Use a Google "Web application" client (Microsoft: "Web"
platform) and register the exact callback URI — see [`examples/oauth-web-server.ts`](https://github.com/anishhs-gh/mailts/blob/master/examples/oauth-web-server.ts). `refreshAccessToken()` throws
`OAuthError` with `oauthCode: 'invalid_grant'` when the user has to sign in again.

| Provider | IMAP | SMTP | Scopes |
|---|---|---|---|
| `google` | imap.gmail.com:993 | smtp.gmail.com:465 | `https://mail.google.com/` (restricted scope — needs Google verification for public apps) |
| `microsoft()` | outlook.office365.com:993 | smtp.office365.com:587 (STARTTLS) | `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access` |

A static `auth: { type: 'xoauth2', user, token }` still works when you manage tokens yourself.

**Scopes per API:** one Microsoft token serves one API — use `microsoft()` for IMAP/SMTP and
`microsoft({ api: 'graph' })` for Graph. `SCOPES` and `googleWith(SCOPES.google.send)` cover narrower Google scopes.

**Organisation-wide (app-only) access** — an admin authorises the app once and your backend uses any mailbox,
no user sign-in:

```ts
import { googleServiceAccountProvider, microsoftAppOnlyProvider } from '@mailts/core/oauth';

// Google Workspace: service account with domain-wide delegation
const google = googleServiceAccountProvider({ credentials: serviceAccountJson, subject: 'support@company.com' });

// Microsoft 365: client credentials (secret or certificate); api: 'graph' for Graph
const ms = microsoftAppOnlyProvider({ tenant: 'contoso.com', clientId, certificate: { privateKey, thumbprint } });

new MailTs({ imap: { host: 'outlook.office365.com', port: 993, secure: true,
                     auth: { type: 'xoauth2', user: 'support@contoso.com', getToken: ms } } });
```

Admin setup steps are in the TSDoc of each function. The Microsoft app-only path is **experimental** (not yet
verified on a live tenant).
