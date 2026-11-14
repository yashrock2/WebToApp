WEBTOAPP - FIRST PWA SCANNER BACKEND CHANGE

Files in this package:
- server.cjs: replace your existing root-level server.cjs with this file.
- pwa/scanner.cjs: add this new file at pwa/scanner.cjs in your project.

No package.json change or new npm dependency is required.
No changes are made to build.cjs or the existing /api/check and /api/build routes.

New endpoint:
POST /api/pwa/scan
JSON body: { "url": "https://example.com" }

The endpoint returns a rule-based scan report with status values such as:
- ready
- needs_setup
- needs_https
- unreachable
- invalid_url

The scanner reuses safeFetch from build.cjs, retaining the existing HTTPS-only fetch behavior,
redirect checks, public-host validation, response size limit, and timeout protections.

After copying the files, run:
node --check server.cjs
node --check pwa/scanner.cjs
node server.cjs

This is backend-only. The current website-check UI still calls /api/check. The next change will
connect the frontend to /api/pwa/scan and display the scan report.
