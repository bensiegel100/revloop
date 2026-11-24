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

Run the **Publish VS Code Extension** workflow from `main`. The workflow rejects
other refs and allows only one release run at a time.

The exact release commit must pass the Linux, Windows, and macOS validation
matrix before the protected Marketplace job can be approved. The workflow then:

1. Rejects an existing version tag or GitHub release.
2. Packages the VSIX once with a commit-derived timestamp.
3. Publishes those exact bytes with OIDC.
4. Creates the matching Git tag and GitHub release with the VSIX and SHA-256
   checksum.

Marketplace versions and GitHub release assets are immutable. Never rerun a
version after changing its source. If Marketplace publishing succeeds but the
GitHub release job fails, recover the release using the original workflow
artifact rather than rebuilding or overwriting it.

## Rollback

Prefer publishing a corrected patch release. If a release must be withdrawn,
unpublish it from the Marketplace publisher portal.

Do not remove the extension unless permanently abandoning its identity.
Marketplace extension names remain reserved after removal, and removal deletes
the extension's statistics.
