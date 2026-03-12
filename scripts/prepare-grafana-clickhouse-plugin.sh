#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ID="grafana-clickhouse-datasource"
PLUGIN_VERSION="${PLUGIN_VERSION:-4.14.0}"
PLUGIN_DIR="/workspace/stack/local-otel/grafana/plugins"
PLUGIN_PATH="${PLUGIN_DIR}/${PLUGIN_ID}"
TMP_ZIP="/tmp/${PLUGIN_ID}-${PLUGIN_VERSION}.zip"

mkdir -p "${PLUGIN_DIR}"
if [ ! -f "${PLUGIN_PATH}/plugin.json" ]; then
  rm -rf "${PLUGIN_PATH}" "${TMP_ZIP}"

  DOWNLOAD_URL="https://grafana.com/api/plugins/${PLUGIN_ID}/versions/${PLUGIN_VERSION}/download"

  echo "Downloading ${PLUGIN_ID}@${PLUGIN_VERSION}"
  curl --fail --location --silent --show-error "${DOWNLOAD_URL}" --output "${TMP_ZIP}"

  export PLUGIN_ID PLUGIN_VERSION
  python3 - <<'PY'
import os
import pathlib
import shutil
import zipfile

plugin_dir = pathlib.Path("/workspace/stack/local-otel/grafana/plugins")
plugin_id = os.environ["PLUGIN_ID"]
plugin_version = os.environ["PLUGIN_VERSION"]
tmp_zip = pathlib.Path(f"/tmp/{plugin_id}-{plugin_version}.zip")

with zipfile.ZipFile(tmp_zip) as zf:
    zf.extractall(plugin_dir)

plugin_json = next(plugin_dir.glob("**/plugin.json"))
expected_dir = plugin_dir / plugin_id
if plugin_json.parent != expected_dir:
    if expected_dir.exists():
        shutil.rmtree(expected_dir)
    shutil.move(str(plugin_json.parent), str(expected_dir))
PY

  rm -f "${TMP_ZIP}"
fi

chmod +x "${PLUGIN_PATH}"/gpx_clickhouse_* 2>/dev/null || true
echo "Grafana ClickHouse plugin ready at ${PLUGIN_PATH}"
