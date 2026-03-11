#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="grafana-clickhouse-datasource"
PLUGIN_VERSION="${PLUGIN_VERSION:-4.14.0}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="${SCRIPT_DIR}/../stack/local-otel/grafana/plugins"
PLUGIN_PATH="${PLUGIN_DIR}/${PLUGIN_ID}"
TMP_ZIP="/tmp/${PLUGIN_ID}-${PLUGIN_VERSION}.zip"

# Safety: only rm -rf paths that are non-empty and inside PLUGIN_DIR
safe_rm_rf() {
  local target="$1"
  [[ -n "${target}" ]] || { echo "ERROR: empty path passed to safe_rm_rf" >&2; exit 1; }
  [[ "${target}" == "${PLUGIN_DIR}/"* ]] || { echo "ERROR: '${target}' is outside PLUGIN_DIR '${PLUGIN_DIR}'" >&2; exit 1; }
  rm -rf "${target}"
}

mkdir -p "${PLUGIN_DIR}"
if [ ! -f "${PLUGIN_PATH}/plugin.json" ]; then
  safe_rm_rf "${PLUGIN_PATH}"
  rm -f "${TMP_ZIP}"

  DOWNLOAD_URL="https://grafana.com/api/plugins/${PLUGIN_ID}/versions/${PLUGIN_VERSION}/download"

  echo "Downloading ${PLUGIN_ID}@${PLUGIN_VERSION}"
  curl --fail --location --silent --show-error "${DOWNLOAD_URL}" --output "${TMP_ZIP}"

  unzip -q "${TMP_ZIP}" -d "${PLUGIN_DIR}"

  PLUGIN_JSON="$(find "${PLUGIN_DIR}" -name "plugin.json" | head -1)"
  [[ -n "${PLUGIN_JSON}" ]] || { echo "ERROR: plugin.json not found after extraction" >&2; exit 1; }
  EXTRACTED_DIR="$(dirname "${PLUGIN_JSON}")"

  if [ "${EXTRACTED_DIR}" != "${PLUGIN_PATH}" ]; then
    safe_rm_rf "${EXTRACTED_DIR}"
    safe_rm_rf "${PLUGIN_PATH}"
    mv "${EXTRACTED_DIR}" "${PLUGIN_PATH}"
  fi

  rm -f "${TMP_ZIP}"
fi

chmod +x "${PLUGIN_PATH}"/gpx_clickhouse_* 2>/dev/null || true
echo "Grafana ClickHouse plugin ready at ${PLUGIN_PATH}"
