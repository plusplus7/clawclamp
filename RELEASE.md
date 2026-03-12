# Release Checklist

## Before Publish

1. Verify package name in `package.json` is `@dejavu/clawclamp`
2. Run tests

```bash
pnpm exec vitest run
```

3. Check README links and screenshots
4. Commit release changes

## Publish To npm

```bash
npm login
npm publish --access public
```

## Publish To GitHub

1. Create repository
2. Push code
3. Add repository description:

> Cedar-based authorization and audit plugin for OpenClaw, built as a vibe-coding / AI-assisted project.

4. Add topics:

`openclaw`, `cedar`, `authorization`, `audit`, `plugin`, `ai-generated`, `vibe-coding`

5. Add screenshots under `screenshots/`
