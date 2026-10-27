"""Independent stdlib XML oracle over retained manifests in this verification corpus."""
import json
import sys
import xml.etree.ElementTree as ET

ANDROID = "{http://schemas.android.com/apk/res/android}"
KINDS = {"activity", "activity-alias", "service", "receiver", "provider"}
DATA_ATTRIBUTES = {
    "scheme": "scheme", "host": "host", "port": "port", "path": "path",
    "path_prefix": "pathPrefix", "path_pattern": "pathPattern",
    "path_advanced_pattern": "pathAdvancedPattern", "path_suffix": "pathSuffix",
    "mime_type": "mimeType",
}


def filter_facts(element):
    def names(tag):
        return [value.get(ANDROID + "name") for value in element.findall(tag)
                if value.get(ANDROID + "name") is not None]

    return {
        "priority": element.get(ANDROID + "priority"),
        "actions": names("action"), "categories": names("category"),
        "data": [{key: value.get(ANDROID + attribute)
                  for key, attribute in DATA_ATTRIBUTES.items()}
                 for value in element.findall("data")],
    }


def main():
    with open(sys.argv[1], encoding="utf-8") as source:
        bundle = json.load(source)
    parent = next(record for record in bundle["records"] if record["evidence_id"] == sys.argv[2])
    root = ET.fromstring(parent["normalized_result"]["manifest"]["text"])
    package = root.get("package")
    application = root.find("application")
    assert application is not None and package, "Verification corpus requires a known package/application"
    inventory = []
    ordinal = 0
    for component in application:
        if component.tag not in KINDS:
            continue
        declared = component.get(ANDROID + "name")
        if declared is None:
            continue
        filters = [filter_facts(value) for value in component.findall("intent-filter")]
        enabled = component.get(ANDROID + "enabled")
        permission = component.get(ANDROID + "permission")
        if permission is None and component.tag != "activity-alias":
            permission = application.get(ANDROID + "permission")
        name = (package + declared if declared.startswith(".") else
                package + "." + declared if "." not in declared else declared)
        inventory.append({
            "source_index": ordinal, "kind": component.tag,
            "declared_name": declared, "name": name,
            "enabled": True if enabled == "true" else False if enabled == "false" else None,
            "enabled_declaration": enabled, "process": component.get(ANDROID + "process"),
            "permission": permission or None, "intent_filters": filters,
            "meta_data": [{"name": value.get(ANDROID + "name")}
                          for value in component.findall("meta-data")],
        })
        ordinal += 1
    selected = [row for row in inventory
                if any(sys.argv[3] in value["actions"] for value in row["intent_filters"])]
    print(json.dumps({"components": selected, "inventory": inventory, "source_components": ordinal},
                     ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
