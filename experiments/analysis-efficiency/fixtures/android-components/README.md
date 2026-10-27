# Static compiled-manifest fixture

These source-owned declarations cover URI data/filter association, exact resource
references, metadata names, component process/enablement and provider URI grants.
`ManifestFixture.smali` supplies a DEX container; it does not implement or execute
the declared Android components. The verification uses existing AAPT2 36.1.0,
Android 36 `android.jar`, JDK 21 and the digest-pinned JADX headless MCP 0.7.1 JAR.
No Android device, emulator or app execution is involved.

From the repository root, choose existing `AAPT2`, `ANDROID_JAR`, `JAVA_HOME` and
`REA_JADX_MCP_JAR` paths, then build into a fresh private directory:

```sh
fixture=experiments/analysis-efficiency/fixtures/android-components
work=$(mktemp -d)
"$AAPT2" compile --dir "$fixture/res" -o "$work/resources.zip"
"$AAPT2" link --manifest "$fixture/AndroidManifest.xml" -I "$ANDROID_JAR" \
  -o "$work/manifest.apk" "$work/resources.zip"
"$JAVA_HOME/bin/java" -Xmx512m -XX:ActiveProcessorCount=2 \
  -cp "$REA_JADX_MCP_JAR" "$fixture/BuildDex.java" \
  "$fixture/ManifestFixture.smali" "$work/classes.dex"
python3 - "$work" <<'PY'
from pathlib import Path
import sys, zipfile
root = Path(sys.argv[1])
with zipfile.ZipFile(root / "manifest.apk", "a") as apk:
    apk.write(root / "classes.dex", "classes.dex")
PY
"$AAPT2" dump xmltree --file AndroidManifest.xml "$work/manifest.apk" > "$work/aapt2-xmltree.txt"
"$AAPT2" dump resources "$work/manifest.apk" > "$work/aapt2-resources.txt"
REA_JADX_HEAP_MIB=1024 REA_JADX_ACTIVE_PROCESSOR_COUNT=2 \
  node scripts/rea.mjs inspect-android-package "$work/manifest.apk" \
  --detail summary --view '{"kind":"android","facet":"components"}' \
  --evidence_output "$work/evidence.json" --json > "$work/cli.json"
python3 "$fixture/verify-fixture.py" "$work"
```

`verify-fixture.py` cross-checks concrete compiled XML facts with the independent
AAPT2 dump, structured CLI facts, parent APK identity and every retained manifest
source location. It deliberately keeps resource declarations unresolved even
though the resource table contains values. `manifest-oracle.py` is a separate
stdlib ElementTree oracle used by the public MCP task driver. Generated binaries,
Evidence and dumps stay outside Git.
