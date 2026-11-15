#!/usr/bin/env bash
# Builds the workspace image from a Codenine CLI archive, as "One workspace per
# person in Docker" in docs/user/business-installation.md describes:
#
#   images/workspace/build.sh release-cli/codenine-<version>-linux-x64.tar.gz codenine-workspace:<version>
#
# Node and Codex are downloaded here and checked against pinned hashes, and Claude
# Code against its pinned version, so the image build itself needs only the Ubuntu
# package mirror.
set -euo pipefail

archive=${1:?usage: images/workspace/build.sh <codenine linux-x64 archive> [image tag]}
tag=${2:-codenine-workspace:latest}

# Pins live here only: Claude Code itself sets CLAUDE_CODE_VERSION in its terminals.
node_version=22.23.4
node_sha256=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce
# Keep in step with @anthropic-ai/claude-agent-sdk in apps/server/package.json.
claude_code_version=2.1.321
# As apps/server/src/provider/CodexInstallation.ts pins it for linux-x64.
codex_url=https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-x86_64-unknown-linux-musl.tar.gz
codex_sha256=1d44b28bc4ac9937d7d3532264baa68a507ce364956a0d4ebb856f331cdee254

context=$(mktemp -d)
trap 'rm -rf "$context"' EXIT
mkdir -p "$context/opt/codenine" "$context/opt/node" "$context/opt/claude" "$context/opt/codex"

tar -xzf "$archive" -C "$context/opt/codenine" --strip-components=1

curl -fsSL -o "$context/node.tar.xz" \
  "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-x64.tar.xz"
echo "$node_sha256  $context/node.tar.xz" | sha256sum --check --quiet
tar -xJf "$context/node.tar.xz" -C "$context/opt/node" --strip-components=1
rm "$context/node.tar.xz"

PATH="$context/opt/node/bin:$PATH" npm install --global --prefix "$context/opt/claude" \
  --no-fund --no-audit "@anthropic-ai/claude-code@$claude_code_version"

installed=$(PATH="$context/opt/node/bin:$PATH" node -p \
  "require('$context/opt/claude/lib/node_modules/@anthropic-ai/claude-code/package.json').version")
[ "$installed" = "$claude_code_version" ] || {
  echo "Installed Claude Code $installed, not $claude_code_version." >&2
  exit 1
}

curl -fsSL -o "$context/codex.tar.gz" "$codex_url"
echo "$codex_sha256  $context/codex.tar.gz" | sha256sum --check --quiet
tar -xzf "$context/codex.tar.gz" -C "$context/opt/codex"
rm "$context/codex.tar.gz"
cp "$(dirname "$0")/codex-config.toml" "$context/codex-config.toml"

# Proxy settings pass through to the package install and stay out of the image.
docker build --tag "$tag" --file "$(dirname "$0")/Dockerfile" \
  --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
  --build-arg http_proxy --build-arg https_proxy --build-arg no_proxy \
  "$context"
