# Lost in a Daydream

Developed by Liad.

**Play it: https://d2a8lxlkw7uke9.cloudfront.net**

> The game was first built under the working name *Perihelion*, so the repository, the project
> folder and the AWS stack (`perihelion-game`) still use that name. Players only ever see
> "Lost in a Daydream" (home-screen label: "Daydream").

A one-button arcade game for the browser. Your ship orbits a burning star on two lanes:
**hold** (Space, Up arrow, W, mouse, or touch) to swing out to the outer orbit and **release** to fall
back in. Dodge the debris, grab orbs, and chain them for combo multipliers. The orbit speeds up the
longer you survive.

- Plain HTML, CSS and JavaScript with no build step and no dependencies
- Canvas rendering, synthesized Web Audio sound effects, works on desktop and mobile
- Installable as an app on phones and works offline (see [Install on your phone](#install-on-your-phone))
- Vibration feedback on Android, and experimental ticks on iPhone (see [Vibration](#vibration)), with an on/off button
- Best score, mute and vibration settings are kept in `localStorage`
- `P` / `Esc` pauses, `M` mutes, and the game auto-pauses when the tab loses focus

```
perihelion/
  site/                  the game (this folder is what gets uploaded)
    index.html
    style.css
    game.js              the game itself
    pwa.js               service worker registration and the install button
    sw.js                service worker: offline cache
    manifest.webmanifest app name, colours and icons for installing
    favicon.svg
    icons/               app icons: the glowing L monogram (regular, maskable and iOS)
  infra/
    template.yaml        CloudFormation stack: private S3 bucket + CloudFront
  tools/
    make_icons.py        regenerates site/icons/ (needs Pillow; also has other logo variants)
```

## Install on your phone

The game is a progressive web app, so there is nothing to download from an app store:

Tap **Install app** on the menu. Chrome and Edge install it right away. Safari, other iPhone
browsers and Firefox cannot be triggered by a website, so the button opens a short guide with the
exact steps for the browser you are using:

- **Android (Chrome, Edge, Samsung Internet):** one tap, or browser menu, **Install app** / **Add to Home screen**.
- **iPhone / iPad (Safari, and Chrome on recent iOS):** **Share** button, then **Add to Home Screen**.
- **Inside Instagram, Facebook and similar apps:** open the page in Safari or Chrome first, those in-app browsers cannot install.

Once installed it opens full screen with its own icon, in portrait or landscape, and keeps working
without a connection after the first visit.

## Vibration

The game uses the browser's Vibration API:

| Moment | Vibration |
| --- | --- |
| Start | short tick (25 ms) |
| Swing out / fall back in | very light tick (14 ms / 10 ms) |
| Grab an orb | pulse that gets stronger as your combo grows (14 ms up to 32 ms) |
| Every 5th orb in a combo | triple pulse |
| Crash | heavy double thud |
| New best score | celebratory pattern |

The vibration button (phone icon next to the sound button) turns it on and off, gives a short
buzz when switched on, and remembers the choice. Pausing cancels any vibration in progress.

**Android (full support):** Chromium-based browsers (Chrome, Edge, Samsung Internet, Opera), in the
browser or installed as an app, with the patterns and strengths above.

**iPhone and iPad (experimental, single ticks only):** Safari, and so every iPhone/iPad browser,
has no Vibration API. As a workaround the game clicks a hidden `<input type="checkbox" switch>`,
which makes Safari 17.4+ play its light system tick. This is an undocumented quirk, so:

- it can only play one fixed light tick, never a pattern or a strength, and each pattern above is
  played as a series of ticks at the start of its pulses;
- WebKit limits it to user gestures, so in practice you feel the tick when you press, release,
  tap Play and tap the vibration button, but probably not for orbs or crashes, which happen between taps;
- it was reportedly closed in iOS 26.5, so on newer iOS versions nothing may happen at all.

Where it does not work nothing breaks. Tapping the vibration button is a quick way to check: it
ticks once when switched on.

**Firefox and computers without a touch screen:** nothing to vibrate, so the button is hidden and
nothing is called. The patterns live in the `Haptics` object in `site/game.js` (Android support
checked against caniuse.com data).

## Run locally

Any static file server works, for example:

```bash
python -m http.server 5173 --directory perihelion/site
```

Then open http://localhost:5173.

## AWS architecture

```
browser --HTTPS--> CloudFront (edge cache, security headers) --OAC / SigV4--> private S3 bucket
```

- **S3 bucket** with all public access blocked, ACLs disabled, SSE-S3 encryption, versioning
  (old versions expire after 30 days) and a bucket policy that denies non-TLS requests.
- **CloudFront** reads the bucket through Origin Access Control. The bucket policy only trusts
  this one distribution (`aws:SourceArn`), so the bucket is never public.
- **Response headers policy** adds a strict Content-Security-Policy (`'self'` only, which is why
  the game has no inline scripts or styles), HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy` and `Permissions-Policy`. The CSP explicitly allows `'self'` for `manifest-src`,
  `worker-src` and `connect-src`; without them `default-src 'none'` would block the web app manifest
  and the service worker's own requests.
- HTTP redirects to HTTPS, HTTP/2 and HTTP/3, IPv6, and gzip/brotli compression are enabled.

Deployed as CloudFormation stack `perihelion-game` in `eu-central-1`.

### Validation

The template passes `cfn-lint` 1.57.2 and the S3 and CloudFront rules from the
[AWS Guard Rules Registry](https://github.com/aws-cloudformation/aws-guard-rules-registry).
Rules that do not fit a small static site are suppressed in the template's `Metadata.guard`
blocks, with the reasons recorded next to them:

| Suppressed rule | Why |
| --- | --- |
| CloudFront custom SSL certificate, SNI, TLS 1.2 minimum | No custom domain; the default `*.cloudfront.net` certificate is used. Add an ACM certificate in us-east-1 to enable these. |
| CloudFront origin failover | Single origin; content is reproducible from `site/`. |
| CloudFront / S3 access logs | Omitted to keep a hobby site simple and free. Add `DistributionConfig.Logging` if you want request logs. |
| S3 replication, Object Lock | Not useful for reproducible static files; Object Lock would block redeploys. |
| S3 public read/write ACL | False positive: the rule fails when `AccessControl` is absent, but ACLs are disabled (`BucketOwnerEnforced`). |

## Redeploy after changing the game

**First bump `VERSION` in `site/sw.js`** (for example `v1` to `v2`). Installed copies of the app
only refresh their offline cache when the service worker file changes.

Then upload and invalidate. Replace the placeholders with the stack outputs `BucketName` and
`DistributionId`. The manifest and service worker are uploaded separately because they need a
specific content type and cache header, and `sw.js` goes last so no browser can fetch a service
worker that points at files that are not uploaded yet:

```bash
aws s3 sync perihelion/site s3://<BucketName> --delete --exclude sw.js --exclude manifest.webmanifest --cache-control "public, max-age=300" --region eu-central-1
```

```bash
aws s3 cp perihelion/site/manifest.webmanifest s3://<BucketName>/ --content-type application/manifest+json --cache-control "public, max-age=300" --region eu-central-1
```

```bash
aws s3 cp perihelion/site/sw.js s3://<BucketName>/ --content-type "text/javascript; charset=utf-8" --cache-control no-cache --region eu-central-1
```

```bash
aws cloudfront create-invalidation --distribution-id <DistributionId> --paths "/*"
```

Files are served with `Cache-Control: public, max-age=300`, so even without an invalidation
visitors get the new version within about five minutes. The invalidation matters for the service
worker: it caches fresh copies when it installs, so it should not read stale ones from the edge.

If you change the icons, edit `tools/make_icons.py` and run `python tools/make_icons.py`.

To change the infrastructure, edit `infra/template.yaml` and update the stack:

```bash
aws cloudformation deploy --stack-name perihelion-game --template-file perihelion/infra/template.yaml --region eu-central-1
```

## Tear down

The bucket is versioned, so it has to be emptied of all object versions before the stack can be
deleted. Empty it from the S3 console (select the bucket and choose **Empty**), then:

```bash
aws cloudformation delete-stack --stack-name perihelion-game --region eu-central-1
```

## Cost

There are no fixed monthly charges. CloudFront's always-free tier covers 1 TB of data transfer
and 10 million requests a month, and storing the ~320 KB site (mostly icons) in S3 costs a fraction
of a cent. Installed copies load from their offline cache, so they add almost no traffic.
Invalidations are not part of the free tier, but the first 1,000 invalidation paths each month
are free, and `/*` counts as one path.
