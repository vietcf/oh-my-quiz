#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMPORT_DIR="${IMPORT_DIR:-$ROOT_DIR/data-imports}"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required but was not found in PATH." >&2
  exit 1
fi

if [ ! -d "$IMPORT_DIR" ]; then
  echo "Import directory not found: $IMPORT_DIR" >&2
  exit 1
fi

shopt -s nullglob
files=("$IMPORT_DIR"/Practice\ Test\ *.mhtml)
shopt -u nullglob

if [ ${#files[@]} -eq 0 ]; then
  echo "No Practice Test .mhtml files found in $IMPORT_DIR" >&2
  exit 1
fi

echo "Import directory: $IMPORT_DIR"
echo "Found ${#files[@]} file(s)."

for file in "${files[@]}"; do
  base_name="$(basename "$file" .mhtml)"
  suffix="${base_name#Practice Test }"
  exam_name="AZ-104 Practice Test $suffix"

  exists="$({
    cd "$ROOT_DIR"
    EXAM_NAME="$exam_name" SKIP_DEMO_SEED=1 node --input-type=module - <<'EOF'
const examName = process.env.EXAM_NAME || '';
const mod = await import('./db.js');
const exists = mod.listExams().some((exam) => String(exam.name || '').trim() === examName);
process.stdout.write(exists ? '1' : '0');
EOF
  })"

  if [ "$exists" = "1" ]; then
    echo "Skipping existing exam: $exam_name"
    continue
  fi

  echo "Importing $base_name -> $exam_name"
  (
    cd "$ROOT_DIR"
    node "scripts/import-mhtml.js" --file "$file" --exam "$exam_name"
  )
done

echo "All available MHTML files have been processed."
