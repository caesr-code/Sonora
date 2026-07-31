#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

for file in src/*.js service-worker.js tests/*.mjs; do
  node --check "$file"
done
node tests/unit.mjs

python3 - <<'PY'
from pathlib import Path
import json, re
root = Path('.')
html = (root/'index.html').read_text()
manifest = json.loads((root/'manifest.webmanifest').read_text())
assert manifest['name'] == 'Sonora Music Player'
ui = (root/'src/ui.js').read_text()
match = re.search(r"const ids = \[(.*?)\];", ui, re.S)
assert match
ids = re.findall(r"'([^']+)'", match.group(1))
missing = [item for item in ids if f'id="{item}"' not in html]
assert not missing, f'Missing HTML ids: {missing}'
for path in manifest['icons']:
    assert (root/path['src']).exists(), path['src']
assert 'src/main.js' in html
assert 'http://' not in html and 'https://' not in html
assert manifest['start_url'] == './' and manifest['scope'] == './'
engine = (root/'src/audio-engine.js').read_text()
assert "addEventListener('ended'" in engine
assert 'this.handleEnded()' in engine
assert 'await this.next(false)' in engine
sw = (root/'service-worker.js').read_text()
assert "new URL('./', self.location.href)" in sw
assert '/__sonora/info' not in ui
assert (root/'.nojekyll').exists()
for required in ['README.md', 'DEPLOY TO GITHUB.md', '404.html', 'assets/icons/apple-touch-icon.png']:
    assert (root/required).exists(), required
for marker in ['TODO', 'FIXME', 'left as an exercise']:
    assert marker not in '\n'.join(path.read_text(errors='ignore') for path in root.rglob('*') if path.is_file() and path.suffix in {'.js','.html','.css','.md','.json','.webmanifest'}), marker
print('HTML, manifest, GitHub Pages and automatic-next checks passed.')
PY


echo "All Sonora verification checks passed."
