# AGENTS.md — DressupHT Fidelity

## Credential and Secret Protection

1. NEVER read, print, display, echo, log, summarize, copy, or expose the actual VALUE of any credential or secret.
2. NEVER ask me to paste a credential, token, API key, password, private key, webhook secret, or service-role key into the chat.
3. NEVER hardcode secret credentials into source code.
4. NEVER place these secrets in frontend/browser-accessible files:
   - SQUARE_ACCESS_TOKEN
   - SQUARE_WEBHOOK_SIGNATURE_KEY
   - SUPABASE_SERVICE_ROLE_KEY
   - database passwords
   - OAuth/client secrets
   - any other private API credential
5. These values must remain in Supabase Edge Function Secrets or the appropriate deployment secret store.
6. OpenCode may reference secret VARIABLE NAMES when necessary, but must never reveal their VALUES.
7. The Supabase anon/publishable key is intentionally browser-visible and is NOT treated as a secret. Do not replace it with the service-role key or any secret key.
8. Do not move server-side secrets into config.js, JavaScript, HTML, CSS, Vercel frontend environment variables, or any other browser-delivered asset.
9. Treat .env, .env.*, credential files, private key files, exported secret files, and similar files as sensitive. Do not display their contents.
10. When auditing for secrets, report ONLY:
    - file path
    - line number if safely available
    - credential TYPE/name
    - whether it appears exposed
    Never report the actual credential value.
11. Never include secret values in git diffs, commit messages, test output, error messages, documentation, screenshots, or generated reports.
12. Before changing authentication, Square, Supabase, webhook, or deployment configuration, inspect the existing architecture first and preserve the current working architecture unless I explicitly request a change.
13. Do not rotate, revoke, replace, or modify any credential unless I explicitly request that action.
14. Do not deploy functions or change Supabase secrets as part of this security audit.
15. For this project, Supabase Edge Function deploy commands must continue to use:
    supabase functions deploy <function-name> --no-verify-jwt