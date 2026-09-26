# Release compatibility: client integration guide

For any Nawara client (web, desktop, iOS, Android) that asks Core's release-service whether the build it is running is still usable
(ADR-0051 decisions 7, 10, 11; Stage 20.5). Release-service only **states** compatibility: it never reloads, downloads, installs,
updates, opens a store or deploys anything. The client acts on the answer.

## The call

```http
GET /release/products/{product}/components/{component}/compatibility?version={your build's version}
If-None-Match: "<ETag of your last decision>"      (optional)
```

- The request is **public**: no bearer, user, device, installation or organization identifier is sent or accepted. It works before
  login.
- `version` is the canonical SemVer of the running build, exactly as CI registered it (for example `2.5.0` or `3.0.0-rc.1`; no `v`, no
  `+build`). The native build number is not sent.
- `{component}` is your client component's registry key as CI registers it (for example `web-app`). Its kind is `web`, `desktop`,
  `mobile_ios` or `mobile_android`; a backend component is not a client (`unknown_component`).

## The answer

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ "update": "required", "reason": "withdrawn" \| "below_minimum", "latestVersion", "minimumVersion" }` | This build must not be used. `withdrawn` wins when both apply. |
| 200 | `{ "update": "available", "latestVersion", "minimumVersion" }` | This build is supported; a newer release exists. **Never forced.** |
| 200 | `{ "update": "none", "latestVersion", "minimumVersion" }` | This build is supported and current. |
| 304 | – | Your cached decision (same `ETag`) still holds. |
| 400 `invalid_version` / 404 `unknown_component` / 404 `unknown_release` | error body | **Not a decision.** Treat as "cannot verify this build" (see below). |
| 429 `rate_limited` | error body | **Not a decision.** Back off, and keep the last trusted decision. |
| 5xx, timeout, network error | – | release-service is unreachable: **fail open** with the last trusted decision (see below). |

**Rules for reading the answer:**
- **Supported ⟺ `update` ≠ `required`.** It is derived by you and never sent.
- **`latestVersion` is a fact, not a target.** It can be *lower* than your version (for example, your build was withdrawn above the
  latest). An installed client updates only to a version greater than its own, and never downgrades because of this field.
- **Freshness.** A decision is cacheable for `Cache-Control: public, max-age=N` (60 s by default) and carries a strong `ETag`.
  Revalidate with `If-None-Match`. A newly required update reaches clients within that time.

## What each client does

| Answer | Web | Desktop (any technology) | iOS / Android |
|---|---|---|---|
| `required` | Stop using the loaded bundle: **reload the deployed application** (the browser fetches whatever is deployed; rolling back is CI redeploying an older web build) | **Block use** until updated through your updater (Tauri, Electron, MSIX, Sparkle, a package manager… release-service knows none of them) | **Block use** and direct the user to the store listing (your app opens the store; release-service never does) |
| `available` | Optional: suggest a refresh | Optional: offer the update | Optional: suggest updating |
| `none` | Continue | Continue | Continue |
| Input error (`invalid_version`, `unknown_component`, `unknown_release`) | Reload (the deployed application is the only version to trust) | Treat as `required` ("cannot verify this build") | Treat as `required` |

**When to check.**
- Installed clients (desktop, mobile): at start, and on resume or foreground.
- Web: at load, and periodically in long-lived tabs (at most every `max-age`).

**Product APIs never depend on this call.** No product request path calls release-service. A backend must not block user requests on it,
and release-service being down must never take a product down.

## When release-service is unreachable (fail open, keep `required`)

```text
reachable      → use the fresh decision; store it (with its ETag) as the last trusted decision
unreachable    → use the last trusted decision:
                   cached required   → STILL required (binding until a fresh answer says otherwise)
                   cached available  → usable
                   cached none       → usable
                   nothing cached    → usable (fail open)
429            → same as unreachable (back off; rate limiting is never a verdict)
```

A cached `required` can only be lifted by a fresh answer from release-service. Never lift it because of an error, a 429 or a timeout.
