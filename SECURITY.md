# Security Policy

## Reporting a Vulnerability

If you find a security issue in this project — a real vulnerability, a
leaked credential, an auth bypass, anything that could put a self-hosted
GM or their players at risk — please report it privately rather than
opening a public GitHub issue:

**Email: support@fates-edge.com**

Include what you found, how to reproduce it, and its potential impact if
you can. There's no bug bounty program, but reports are taken seriously and
credited (if you'd like) once a fix ships.

## Scope

This bot is designed to be self-hosted by individual GMs, typically on a
home machine or a small VPS alongside the Fate's Edge Socket Server it
connects to. A few things worth knowing:

- The optional **status dashboard** (`STATUS_SERVER`, default on) binds to
  `127.0.0.1` only by default and has no authentication — it's meant for
  your own machine. Setting `STATUS_HOST=0.0.0.0` to expose it beyond
  localhost is an explicit opt-in; see the "Status Dashboard" section of
  [README.md](README.md) before doing so.
- API keys and credentials belong in a local `.env` file only (see
  [INSTALL.md](INSTALL.md)) — `.env` is gitignored and should never be
  committed.
- The optional Elasticsearch "Long-Term Memory" feature's bundled
  `docker-compose.yml` service runs with security disabled by design —
  that configuration is for local development only, not production. See
  the "Long-Term Memory" section of README.md.

## Supported Versions

This project follows [Semantic Versioning](https://semver.org/) (see
[VERSIONING.md](VERSIONING.md)). Only the latest released version is
actively supported; please update before reporting an issue if you're
running an older tag.
