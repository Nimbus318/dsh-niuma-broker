#!/usr/bin/env bash
set -euo pipefail

# The hosted runner's default regional mirror can stall on the CJK font archive.
font_sources="$RUNNER_TEMP/niuma-fonts.list"
printf '%s\n' 'deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://azure.archive.ubuntu.com/ubuntu noble main' > "$font_sources"

apt_options=(
  -o "Dir::Etc::sourcelist=$font_sources"
  -o Dir::Etc::sourceparts=-
  -o Acquire::Languages=none
  -o Acquire::https::Timeout=30
  -o Acquire::Retries=2
)
sudo apt-get "${apt_options[@]}" update
sudo apt-get "${apt_options[@]}" install --yes fonts-noto-cjk
