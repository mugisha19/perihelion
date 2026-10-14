# Perihelion

**Play it: https://d2a8lxlkw7uke9.cloudfront.net**

A one-button arcade game for the browser. Your ship orbits a burning star on two lanes:
**hold** (Space, Up arrow, W, mouse, or touch) to swing out to the outer orbit and **release** to fall
back in. Dodge the debris, grab orbs, and chain them for combo multipliers. The orbit speeds up the
longer you survive.

- Plain HTML, CSS and JavaScript with no build step and no dependencies
- Canvas rendering, synthesized Web Audio sound effects, works on desktop and mobile
- Best score and mute setting are kept in `localStorage`
- `P` / `Esc` pauses, `M` mutes, and the game auto-pauses when the tab loses focus

```
perihelion/
  site/              the game (this folder is what gets uploaded)
    index.html
    style.css
    game.js
    favicon.svg
  infra/
    template.yaml    CloudFormation stack: private S3 bucket + CloudFront
```

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
  `Referrer-Policy` and `Permissions-Policy`.
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

Equivalent AWS CLI commands (replace the placeholders with the stack outputs `BucketName` and
`DistributionId`):

```bash
aws s3 sync perihelion/site s3://<BucketName> --delete --cache-control "public, max-age=300" --region eu-central-1
```

```bash
aws cloudfront create-invalidation --distribution-id <DistributionId> --paths "/*"
```

Files are served with `Cache-Control: public, max-age=300`, so even without an invalidation
visitors get the new version within about five minutes.

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
and 10 million requests a month, and storing the ~40 KB site in S3 costs a fraction of a cent.
Invalidations are not part of the free tier, but the first 1,000 invalidation paths each month
are free, and `/*` counts as one path.
