# Pearl Hub Server

The backend of [Pearl Hub](https://pearlhub.net), a self-custody Pearl ($PRL) wallet and mining monitor. It is one Cloudflare Worker with a D1 database, serving `pearlhub.net/v1/*`:

- **Price alerts and Lock Screen live price**: checks the PRL price every minute and notifies through Apple Push Notification service and Web Push.
- **Offline alerts**: asks the mining pools' public APIs about the monitors a user switched alerts on for, and notifies when a worker goes offline or comes back.
- **Public data**: the PRL price, a pools overview, pool fees, network samples and the GPU table, shared by the apps and the web version.
- **Optional email accounts**: sign-in with one-time codes, configuration sync, device management, and linking App Store or PRL purchases.
- **PRL checkout** for the web version: exact-amount orders matched against the chain.

The server never receives recovery phrases, private keys or exchange API keys. What each feature sends and keeps is listed in the app under **Settings → Security Overview** and in the [privacy policy](https://pearlhub.net/privacy).

Related repositories: the iPhone / iPad / Mac app is [terryops/prl-hub](https://github.com/terryops/prl-hub) and the web frontend is [terryops/prl-hub-web](https://github.com/terryops/prl-hub-web).

## Layout

- `alerts/src/`: the Worker (`index.js` lists every route).
- `alerts/schema.sql`, `alerts/migrations/`: the D1 schema.
- `alerts/test/`: tests, run with Node's built-in test runner against SQLite (`node:sqlite`).
- `Sources/PRLMonitor/gpus.json` and `Tests/Fixtures/`: the GPU table and pool response samples, shared with the app repository at the same paths.

## Tests

Node.js 22.6 or later:

```sh
cd alerts
npm test
```

## Deploying your own

1. `npm ci` in `alerts/`, then create a D1 database (`npx wrangler d1 create prl-alerts`) and put its id in `wrangler.toml`.
2. Set the `[vars]` in `wrangler.toml` to your own: Apple team id, APNs key id, bundle ids, routes and so on.
3. Add the secrets with `npx wrangler secret put <NAME>`: `APNS_KEY`, `INGEST_TOKEN`, `ASN_SECRET`, `VAPID_PRIVATE`, `ADMIN_TOKEN`, `AUTH_PEPPER`, `ACCOUNT_CONFIG_KEY` and `TURNSTILE_SECRET`.
4. Apply the schema (`npx wrangler d1 execute prl-alerts --remote --file=schema.sql`, then `npx wrangler d1 migrations apply prl-alerts --remote`) and run `npx wrangler deploy`.

`npm run deploy` also builds the web frontend, which it expects in a [prl-hub-web](https://github.com/terryops/prl-hub-web) checkout next to this repository.

## License

Copyright (C) 2026 Cyber Corner

Pearl Hub Server is free software, released under the [GNU Affero General Public License v3.0](LICENSE).
