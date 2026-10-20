#!/usr/bin/env bash
# Publishes a drafted release as an update: copies its files to the server's update folders,
# where the installed apps find them within six hours.
#
#   infra/publish-update.sh v0.2.0 you@assist.example.com [remote-assist/infra]
#
# Needs the GitHub CLI (signed in) and SSH access to the server. Try the release on your own
# Mac first: once the update files are copied, every installed app takes the new version.
set -euo pipefail

tag=${1:?Usage: infra/publish-update.sh <tag> <user@server> [infra folder on the server]}
server=${2:?Usage: infra/publish-update.sh <tag> <user@server> [infra folder on the server]}
remote=${3:-remote-assist/infra}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
gh release download "$tag" --dir "$work"

ssh "$server" "mkdir -p '$remote/updates/host' '$remote/updates/helper'"
# Installers and update archives first...
scp "$work"/RemoteAssist-* "$server:$remote/updates/host/"
scp "$work"/RemoteAssistHelper-* "$server:$remote/updates/helper/"
# ...then the files that announce the new version, so no app looks for a download too early.
scp "$work/host-latest-mac.yml" "$server:$remote/updates/host/latest-mac.yml"
scp "$work/helper-latest-mac.yml" "$server:$remote/updates/helper/latest-mac.yml"
echo "Published $tag. Installed apps update within six hours."
