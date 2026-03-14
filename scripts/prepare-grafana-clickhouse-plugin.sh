#!/usr/bin/env bash
set -euo pipefail

# Resolve the project root relative to this script's location.
# Works on both Linux and macOS, whether invoked directly or via npm scripts.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PLUGIN_ID="grafana-clickhouse-datasource"
PLUGIN_VERSION="${PLUGIN_VERSION:-4.14.0}"
PLUGIN_DIR="${PROJECT_ROOT}/stack/local-otel/grafana/plugins"
PLUGIN_PATH="${PLUGIN_DIR}/${PLUGIN_ID}"
TMP_ZIP="${TMPDIR:-/tmp}/${PLUGIN_ID}-${PLUGIN_VERSION}.zip"

mkdir -p "${PLUGIN_DIR}"
if [ ! -f "${PLUGIN_PATH}/plugin.json" ]; then
  rm -rf "${PLUGIN_PATH}" "${TMP_ZIP}"

  DOWNLOAD_URL="https://grafana.com/api/plugins/${PLUGIN_ID}/versions/${PLUGIN_VERSION}/download"

  echo "Downloading ${PLUGIN_ID}@${PLUGIN_VERSION}"
  curl --fail --location --silent --show-error "${DOWNLOAD_URL}" --output "${TMP_ZIP}"

  # Extract zip — use unzip (available on both Linux and macOS, no python3 needed)
  if ! command -v unzip >/dev/null 2>&1; then
    echo "Error: 'unzip' is required but not found. Install it with:" >&2
    echo "  Linux:  sudo apt-get install unzip" >&2
    echo "  macOS:  unzip is pre-installed" >&2
    exit 1
  fi

  unzip -q -o "${TMP_ZIP}" -d "${PLUGIN_DIR}"

  # The zip may extract into a differently-named directory. Find plugin.json
  # and rename its parent to the expected plugin ID directory.
  FOUND_PLUGIN_JSON="$(find "${PLUGIN_DIR}" -maxdepth 3 -name plugin.json -print -quit)"
  if [ -z "${FOUND_PLUGIN_JSON}" ]; then
    echo "Error: plugin.json not found after extraction" >&2
    exit 1
  fi

  EXTRACTED_DIR="$(dirname "${FOUND_PLUGIN_JSON}")"
  if [ "${EXTRACTED_DIR}" != "${PLUGIN_PATH}" ]; then
    rm -rf "${PLUGIN_PATH}"
    mv "${EXTRACTED_DIR}" "${PLUGIN_PATH}"
  fi

  rm -f "${TMP_ZIP}"
fi

chmod +x "${PLUGIN_PATH}"/gpx_clickhouse_* 2>/dev/null || true
echo "Grafana ClickHouse plugin ready at ${PLUGIN_PATH}"
