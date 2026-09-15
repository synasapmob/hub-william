# ADR-0004: Railway private backend behind the frontend origin

- Status: Accepted
- Date: 2026-09-10

## Context

The browser needs the Hub auth, pool, provider-connection, key, and streaming
APIs, but publishing the Rust service on its own internet hostname would expose
an unnecessary second origin and invite direct probing. Railway private
networking is IPv6-based and reachable only by services in the same project;
a browser cannot resolve or connect to that network directly.

## Decision

- Only the frontend service receives a public Railway domain.
- The frontend Nginx service serves the prerendered React application and
  reverse-proxies same-origin `/api/*` requests to the backend's
  `*.railway.internal` hostname.
- The backend has no public domain and listens on the IPv6 unspecified address
  so Railway private networking can reach it.
- Production browser cookies are `Secure`; PostgreSQL and the credential
  encryption key reach only the backend through Railway reference and secret
  variables.
- Local development keeps the direct `http://localhost:8080` API default and
  accepts both `localhost:5173` and `127.0.0.1:5173` origins.

## Consequences

- Browser network tools reveal only the public frontend origin and `/api`
  paths, not a backend hostname or public backend IP.
- Nginx must preserve streaming responses and `Set-Cookie` headers while
  stripping the `/api` prefix before forwarding.
- The frontend becomes the public availability boundary. Rate limiting, WAF,
  and abuse controls should be configured there before broad public promotion.
- Private networking hides backend addressing; it does not replace
  authentication or authorization on sensitive routes.
