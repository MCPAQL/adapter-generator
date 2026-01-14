# Pending Work: Infrastructure Setup

## Summary
Infrastructure setup for the adapter-generator repository - a CLI tool for generating MCP-AQL compliant adapters from schema definitions.

## Current State
- Repository exists with basic structure
- No CI/CD workflows
- No branch protection or git flow
- Issues #1-7 created to track infrastructure work

## Work To Complete

### 1. Git Flow Setup (Issue #1)
**Purpose**: Establish consistent branching strategy

Tasks:
- Create `develop` branch from `main`
- Configure branch protection for `main` and `develop`
- Document branching strategy in CONTRIBUTING.md

### 2. CI Workflow (Issue #2)
**Purpose**: Automated build, test, and lint on every PR

Tasks:
- Create `.github/workflows/ci.yml`
- Configure ESLint and Prettier
- Set up test framework
- Test generator output validation
- CLI integration tests
- Test on Node 18.x, 20.x, 22.x

### 3. Release Workflow (Issue #3)
**Purpose**: Automated npm publishing on version tags

Tasks:
- Create `.github/workflows/release.yml`
- Configure NPM_TOKEN secret
- Publish as `@mcpaql/adapter-generator`
- CLI should be installable via `npx @mcpaql/adapter-generator`
- Create GitHub release with changelog

### 4. Issue and PR Templates (Issue #4)
**Purpose**: Standardize contributions

Tasks:
- Create bug report template
- Create feature request template
- Create PR template
- Create config.yml

### 5. CODEOWNERS (Issue #5)
**Purpose**: Automatic review assignment

Tasks:
- Create `.github/CODEOWNERS`
- Note: Requires creating GitHub teams

### 6. CodeQL Security Scanning (Issue #6)
**Purpose**: Automated vulnerability detection

Tasks:
- Create `.github/workflows/codeql.yml`
- Configure for JavaScript/TypeScript
- Weekly scheduled scans

### 7. Dependabot (Issue #7)
**Purpose**: Automated dependency updates

Tasks:
- Create `.github/dependabot.yml`
- Configure npm and GitHub Actions ecosystems

## Prerequisites

- GitHub teams for CODEOWNERS
- NPM_TOKEN secret for releases
- Branch protection requires GitHub Pro for private repos

## Recommended Order

1. CI workflow (#2)
2. CodeQL (#6) and Dependabot (#7)
3. Git flow (#1)
4. Templates (#4) and CODEOWNERS (#5)
5. Release workflow (#3)

## Additional Considerations

This tool generates adapters, so tests should verify:
- Generated code compiles without errors
- Generated code follows MCP-AQL patterns
- CLI argument parsing works correctly
- Template rendering is correct

## Reference

See `MCPAQL/spec` repository for examples of completed infrastructure.
