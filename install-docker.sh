#!/usr/bin/env bash
# Install Docker Engine and the compose plugin on Ubuntu from Docker's apt repository.
# Run as root or as a user with sudo. The compose plugin provides `docker compose`;
# the old standalone docker-compose binary is not needed.
set -euo pipefail
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null || { echo "error: run as root or install sudo" >&2; exit 1; }
  SUDO="sudo"
fi
$SUDO apt-get update -y
$SUDO apt-get install ca-certificates curl -y
$SUDO install -m 0755 -d /etc/apt/keyrings
$SUDO curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
$SUDO chmod a+r /etc/apt/keyrings/docker.asc
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | \
  $SUDO tee /etc/apt/sources.list.d/docker.list > /dev/null
$SUDO apt-get update -y
$SUDO apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin -y
docker compose version
