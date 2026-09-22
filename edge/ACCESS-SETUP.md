# Cloudflare Access setup

This deployment is locked to a single address: **mariosxen7@icloud.com**.

Getting that right takes two independent pieces. Both matter, and the most
common way these deployments end up publicly readable is doing only the first.

1. **An Access application** in front of the domain, with a policy allowing one
   email. This is what shows you a login page.
2. **The Worker verifying the token itself** (`src/middleware/access.ts`). This
   is what stops anyone who reaches the Worker by another route.

Why the second is not paranoia: Access protects a *route on a domain*. It does
not protect the `*.workers.dev` hostname every Worker also gets, and it does not
notice if you later delete and recreate the application, mistype a policy, or
change the route. Without in-Worker verification, any of those quietly turns the
app into an open one.

---

## 1-3. Create the resources and deploy once

See **[DEPLOY.md](DEPLOY.md)** steps 1 to 5: create the D1 database
(`fc27-sbc-assistant-club`) and the KV namespace (`ACCESS_KEYS`), run the
migrations, set your hostname, and deploy.

Deploy before creating the Access application — the app must exist at that
hostname before Access can be pointed at it. It is not exposed in the meantime:
`ACCESS_AUD` is still a placeholder, and `verifyAccessJwt` refuses every request
while that is true.

## 4. Create the Access application

In the Cloudflare dashboard: **Zero Trust → Access → Applications → Add an
application → Self-hosted**.

| Field | Value |
|---|---|
| Application name | FC 27 SBC Assistant |
| Session duration | 24 hours (or whatever suits you) |
| Subdomain / domain | `sbc` / `yourdomain.com` |
| Path | leave empty, so the whole app is covered |

### The policy

Add one policy:

| Field | Value |
|---|---|
| Policy name | Only me |
| Action | **Allow** |
| Rule type | Include |
| Selector | **Emails** |
| Value | `mariosxen7@icloud.com` |

Use **Emails**, not *Emails ending in* and not *Everyone*. One address, exactly.

Make sure there is no second policy. A **Bypass** policy on the same application
disables authentication for whatever it matches, which would undo all of this.

### Login method

Under **Settings → Authentication**, enable at least one identity provider. The
built-in **One-time PIN** works with any address including iCloud, and needs no
external setup — Cloudflare emails you a code. That is the simplest thing that
works here.

## 5. Copy the AUD tag

Open the application you just created → **Overview** → **Application Audience
(AUD) Tag**. It is a 64-character hex string.

In `wrangler.toml`, set it in **both** `[vars]` blocks:

```toml
ACCESS_AUD = "the-64-character-aud-tag"
ACCESS_TEAM_DOMAIN = "yourteam"     # from yourteam.cloudflareaccess.com
```

Your team name is in **Zero Trust → Settings → Custom Pages**, or just read it
out of the `*.cloudflareaccess.com` URL you get sent to when logging in.

This AUD check is the reason a token minted for a *different* Access application
on your account cannot be replayed against this one.

## 6. Deploy again and verify

```bash
npm run deploy
```

Now check it actually works, in this order:

```bash
# 1. Health is public by design, and says nothing useful.
curl https://sbc.yourdomain.com/health
# {"ok":true}

# 2. The API must refuse an unauthenticated request.
curl -i https://sbc.yourdomain.com/api/club/summary
# HTTP/2 403 ... "code":"NO_ACCESS_TOKEN"

# 3. So must the UI. If this returns 200 with HTML, run_worker_first is not
#    taking effect and the dashboard is being served straight off the asset
#    server without ever reaching the Access check.
curl -i https://sbc.yourdomain.com/
# HTTP/2 403

# 4. A forged token must not get through.
curl -i -H 'Cf-Access-Jwt-Assertion: eyJhbGciOiJub25lIn0.eyJlbWFpbCI6Im1hcmlvc3hlbjdAaWNsb3VkLmNvbSJ9.' \
  https://sbc.yourdomain.com/api/club/summary
# HTTP/2 403 ... "code":"INVALID_ACCESS_TOKEN"
```

Then open `https://sbc.yourdomain.com` in a browser. You should get the
Cloudflare login, and after it the dashboard, with your address shown in the
sidebar under "Signed in via Cloudflare Access".

**Confirm the workers.dev route is gone.** In the dashboard under **Workers &
Pages → fc27-sbc-assistant-prod → Settings → Domains & Routes**, there should be no
`workers.dev` entry. `workers_dev = false` in `wrangler.toml` handles this, but
it is worth seeing with your own eyes, because that hostname bypasses Access
entirely.

---

## Changing who can get in

Two places, and both must agree:

1. The Access policy in the dashboard.
2. `ALLOWED_EMAIL` in `wrangler.toml`, followed by a redeploy.

The duplication is intentional. Widening the Access policy alone does not grant
entry, because the Worker still checks the address itself — so a fat-fingered
policy edit fails closed rather than open.

## Troubleshooting

| Symptom | Cause |
|---|---|
| 403 with `NO_ACCESS_TOKEN` in a browser | Access is not in front of this hostname. Check the application's domain matches the route exactly. |
| 403 with `INVALID_ACCESS_TOKEN` | Usually `ACCESS_AUD` or `ACCESS_TEAM_DOMAIN` is wrong or still says `REPLACE_WITH_…`. `npx wrangler tail --env production` prints the specific reason. |
| 403 with `NOT_ALLOWLISTED` | Access let someone in that `ALLOWED_EMAIL` does not match. Your Access policy is broader than you think — check for a second policy. |
| Dashboard loads with no login | `run_worker_first` is not applied. Assets are being served before the Worker. |
| Logged in but every API call 403s | Session expired mid-visit. Reload. |

`npx wrangler tail --env production` shows the exact rejection reason for every
403. The client is told only "Forbidden" on purpose — an unauthenticated caller
learning *why* it failed is a gift to whoever is probing.
