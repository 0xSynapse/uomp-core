# UOMP Reference Implementation Documentation

This directory contains design and implementation documents for the UOMP reference implementation (`uomp-mvp`).

For current usage, start with the [README Quick start](../README.md#quick-start). For the protocol specification, see the [UOMP website/spec](https://www.uomp.org/spec/).

## Current product docs

| Document | 中文 | English |
|----------|------|---------|
| Quick start / CLI / MCP | [`../README.md`](../README.md) | [`../README.md`](../README.md) |
| Protocol draft Draft-00 | [`../specs/draft-00.md`](../specs/draft-00.md) | [`../specs/draft-00.en.md`](../specs/draft-00.en.md) |
| CLI/SDK Design (historical, with current CLI summary) | [`cli-sdk-design.md`](./cli-sdk-design.md) | [`cli-sdk-design.en.md`](./cli-sdk-design.en.md) |
| SDK Design (API & Architecture, Node.js focus) | [`sdk-design.md`](./sdk-design.md) | [`sdk-design.en.md`](./sdk-design.en.md) |

## Advanced / preview / research docs

These documents are useful context, but they are not the current core workflow:

| Document | 中文 | English | Status |
|----------|------|---------|--------|
| Remote Authorization Design | [`remote-authorization-design.md`](./remote-authorization-design.md) | [`remote-authorization-design.en.md`](./remote-authorization-design.en.md) | Preview |
| Deployment Guide | [`deployment-guide.md`](./deployment-guide.md) | — | Advanced / preview |
| Store Abstraction Design | [`store-abstraction-design.md`](./store-abstraction-design.md) | — | Research |
| On-chain Audit Design | [`on-chain-audit-design.md`](./on-chain-audit-design.md) | — | Research |

The core current loop is: import Markdown/CSV/JSON, authorize a scoped session, run the local server, read through Memory Guard, inspect `sessions` / `audit`, and revoke. `uomp mcp` adds an experimental stdio MCP bridge for Claude Desktop, Cursor, and other clients.
