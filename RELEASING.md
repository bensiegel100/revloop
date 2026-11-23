# Releasing Revloop

Revloop publishes its VS Code extension through GitHub Actions and Visual Studio
Marketplace Trusted Publishing. Do not create or store a Marketplace Personal
Access Token.

## One-time setup

The Marketplace publisher is `bensiegel`, and the extension identity is
`bensiegel.revloop`.

The `marketplace` GitHub environment protects the publishing job. Visual Studio
Marketplace must have a Trusted Publishing policy with these exact values:

| Field            | Value                |
| ---------------- | -------------------- |
| Repository owner | `bensiegel100`       |
| Repository       | `revloop`            |
| Workflow         | `publish-vscode.yml` |
| Environment      | `marketplace`        |

## Prepare a release

1. Choose a SemVer version and update the extension workspace:

   ```bash
   npm version 0.1.0 --workspace revloop --no-git-tag-version
   ```

2. Update `vscode/CHANGELOG.md`.
3. Run the complete release gate:

   ```bash
   npm ci
   npm run check
   npm run test:extension
   npm run test:plugin
   npm run test:fuzz
   npm run package:vscode
   ```

4. Inspect the generated VSIX with:

   ```bash
   npm exec --workspace revloop -- vsce ls --no-dependencies
   ```

5. Commit the release changes and push `main`.

## Publish

Either create and push the matching `v<version>` tag or manually run the
**Publish VS Code Extension** workflow. A tag-triggered run fails before
publishing when the tag does not match `vscode/package.json`.

The workflow validates the release, packages the VSIX once, publishes it with
OIDC, and attaches the VSIX and its SHA-256 checksum to the matching GitHub
release.

## Rollback

Prefer publishing a corrected patch release. If a release must be withdrawn,
unpublish it from the Marketplace publisher portal.

Do not remove the extension unless permanently abandoning its identity.
Marketplace extension names remain reserved after removal, and removal deletes
the extension's statistics.
