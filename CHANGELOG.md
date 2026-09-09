# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versioning rules for this repository:

- While the package is **not published**, a version is bumped and tagged at the close of each day
  that changed it.
- Once it is **live**, CI/CD performs the bump on every push, and nothing is pushed without the
  owner's approval.

## [Unreleased]

## [0.1.0] - 2026-09-09

### Added

- MCP server speaking stdio, published as `@veewer/mcp` and runnable with
  `npx -y @veewer/mcp`.
- Eight read-only tools over the VEEWER public API: `list_models`, `search_models`, `get_model`,
  `list_folders`, `get_embed_code`, `get_share_link`, `get_viewer_url` and `get_account`.
- API key authentication through the `VEEWER_API_KEY` environment variable, sent as the
  `x-api-key` header. `VEEWER_API_URL` overrides the base URL for testing against a non-production
  VEEWER instance.
- Errors are reported with the message the API returned, so a revoked key or an unknown model
  reads as what it is rather than as a status code. A rate-limited request is reported as such.

### Notes

- Upload, rename and delete are deliberately absent in this version: uploading spends account
  credits and deleting cannot be undone, neither of which belongs in an agent's hands yet.

[Unreleased]: https://github.com/codeo-engineering/veewer-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/codeo-engineering/veewer-mcp/releases/tag/v0.1.0
