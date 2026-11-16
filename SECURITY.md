# Security policy

Report suspected vulnerabilities privately using
[GitHub private vulnerability reporting](https://github.com/curlewlabs-com/d1-follow/security/advisories/new).
Include the affected release or commit, reproduction steps and the observed
impact. Keep credentials, account identifiers and personal data out of public
issues.

Curlew Labs maintains this repository; Jeffrey Wall
([jeffwall-curlewlabs](https://github.com/jeffwall-curlewlabs)) is the release
and security contact through GitHub. Reports are reviewed on a best-effort basis
without a guaranteed response time. Fixes target the latest release; older
release lines have no promised backport window.

## Trust boundary

The package runs inside your Worker with your bindings and makes no call of its
own: every request and query goes through the `fetch`, D1 handles and object
calls your app passes in. The one URL it chooses is
`https://cloudflare.com/cdn-cgi/trace`, read through your `fetch` to learn the
colo the isolate runs in. It trusts the `meta` of your own D1 results.
