# Security policy

UnMeta reads untrusted files inside the browser, so parser bugs matter. Please report anything that could let a
file leak data off the page, crash or hang the engine, or leave private details behind in a copy UnMeta calls clean.

**Report privately:** https://github.com/kabirsharma09/unmeta/security/advisories/new

Include a sample file (or how to make one) and what you saw. Please don't open a public issue for a vulnerability.
You'll get a reply within a week. Fixes ship to https://unmeta.vercel.app as soon as they pass the test suites.

Out of scope: the static host's own infrastructure, and findings that need a modified browser.
