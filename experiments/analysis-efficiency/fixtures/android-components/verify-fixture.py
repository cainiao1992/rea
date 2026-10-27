"""Check real AAPT2/JADX/CLI facts against the source-built manifest corpus."""
import hashlib
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
reply = json.loads((root / "cli.json").read_text())["summary"]
view = reply["normalized_result"]
bundle = json.loads((root / "evidence.json").read_text())
parent = next(record for record in bundle["records"]
              if record["evidence_id"] == view["parent_evidence_id"])
sha256 = hashlib.sha256((root / "manifest.apk").read_bytes()).hexdigest()
assert parent["subject"]["digest"]["sha256"] == view["artifact"]["sha256"] == sha256
assert reply["evidence_links"] == [parent["evidence_id"]]
assert view["source_status"] == "complete" and view["source_components"] == 3
assert view["coverage"]["exhausted"] and view["coverage"]["total"] == 3
activity, receiver, provider = view["items"]
assert [row["source_index"] for row in view["items"]] == [0, 1, 2]
assert all(row["declaration_coverage"] == "complete" for row in view["items"])
assert activity["enabled"] is False and activity["process"] == ":activity"
first, second = activity["intent_filters"]
assert first["actions"] == ["android.intent.action.VIEW"] and first["priority"] == "7"
assert first["data"][0]["scheme"] == "https"
assert first["data"][0]["host"] == "example.test" and first["data"][0]["path_prefix"] == "/open"
assert second["actions"] == ["android.intent.action.EDIT"]
assert second["priority"] == "@integer/filter_priority"
assert second["data"][0]["scheme"] == "content" and second["data"][0]["mime_type"] == "text/plain"
assert activity["meta_data"][0]["name"] == "public.configuration"
assert "value" not in activity["meta_data"][0]
assert receiver["enabled"] is None and receiver["enabled_declaration"] == "@bool/receiver_enabled"
assert receiver["process"] == ":sms" and receiver["permission"] == "android.permission.BROADCAST_SMS"
assert receiver["intent_filters"][0]["priority"] == "-10"
assert provider["enabled"] is True and provider["grant_uri_permissions"] is True
assert provider["grant_uri_permissions_declaration"] == "true" and provider["process"] is None
manifest = parent["normalized_result"]["manifest"]["text"]
assert manifest.isascii() and "retained-in-manifest" in manifest
for row in view["items"]:
    nodes = [(row, row["kind"])]
    for element in row["intent_filters"]:
        nodes.append((element, "intent-filter"))
        nodes.extend((data, "data") for data in element["data"])
    nodes.extend((metadata, "meta-data") for metadata in row["meta_data"])
    for node, tag in nodes:
        location = node["location"]
        offset = location["offset"]
        assert manifest[offset:].startswith("<" + tag)
        assert manifest[:offset].count("\n") + 1 == location["line"]
        assert offset - manifest.rfind("\n", 0, offset) == location["column"]
tree = (root / "aapt2-xmltree.txt").read_text()
for fragment in [':scheme(0x01010027)="https"', ':host(0x01010028)="example.test"',
                 ':pathPrefix(0x0101002b)="/open"', ':priority(0x0101001c)=7',
                 ':priority(0x0101001c)=-10', ':priority(0x0101001c)=@0x7f020000',
                 ':enabled(0x0101000e)=@0x7f010000', ':grantUriPermissions(0x0101001b)=true']:
    assert fragment in tree, fragment
print(json.dumps({"compiled_manifest_cli": "passed", "sha256": sha256,
                  "components": 3, "filter_grouping": True, "locations": True,
                  "resource_values_remain_declarations": True, "aapt2_oracle": True}))
