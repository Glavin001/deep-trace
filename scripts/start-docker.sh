#!/usr/bin/env bash
set -euo pipefail

DOCKER_SOCKET="${DOCKER_SOCKET:-unix:///tmp/docker.sock}"
DOCKER_SOCKET_PATH="${DOCKER_SOCKET#unix://}"
DOCKER_DATA_ROOT="${DOCKER_DATA_ROOT:-/tmp/dockerd-data}"
DOCKER_EXEC_ROOT="${DOCKER_EXEC_ROOT:-/tmp/dockerd-exec}"
DOCKER_PIDFILE="${DOCKER_PIDFILE:-/tmp/dockerd.pid}"
DOCKER_LOG="${DOCKER_LOG:-/tmp/dockerd.log}"

if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y docker.io docker-compose-v2
fi

if ! getent group docker | rg -q "(^|:)[^:]*:[^:]*:.*\\b${USER}\\b"; then
  sudo usermod -aG docker "${USER}"
fi

if sudo test -S "${DOCKER_SOCKET_PATH}"; then
  if sudo env DOCKER_HOST="${DOCKER_SOCKET}" docker info >/dev/null 2>&1; then
    echo "Docker already available on ${DOCKER_SOCKET}"
    echo "Use: export DOCKER_HOST=${DOCKER_SOCKET}"
    exit 0
  fi
fi

sudo mkdir -p "${DOCKER_DATA_ROOT}" "${DOCKER_EXEC_ROOT}"

sudo nohup dockerd \
  --host="${DOCKER_SOCKET}" \
  --data-root="${DOCKER_DATA_ROOT}" \
  --exec-root="${DOCKER_EXEC_ROOT}" \
  --pidfile="${DOCKER_PIDFILE}" \
  --storage-driver=vfs \
  --iptables=false \
  --ip6tables=false \
  > "${DOCKER_LOG}" 2>&1 &

for _ in $(seq 1 40); do
  if sudo env DOCKER_HOST="${DOCKER_SOCKET}" docker info >/dev/null 2>&1; then
    echo "Docker is ready on ${DOCKER_SOCKET}"
    echo "Use one of:"
    echo "  export DOCKER_HOST=${DOCKER_SOCKET} && sudo -E docker ps"
    echo "  sg docker -c 'export DOCKER_HOST=${DOCKER_SOCKET} && docker ps'"
    exit 0
  fi
  sleep 1
done

echo "Docker did not become ready; recent daemon log:"
sudo tail -n 40 "${DOCKER_LOG}"
exit 1
