"""Exercise the Hopper bridge facade without importing Hopper globals."""

import json
from pathlib import Path
import sys


class FakeDocument:
    def __init__(self):
        self.analysis_active = True

    def getDocumentName(self):
        return "fixture"

    def getExecutableFilePath(self):
        return "/tmp/rea-hopper-facade-fixture"

    def getDatabaseFilePath(self):
        return None

    def backgroundProcessActive(self):
        return self.analysis_active

    def getCurrentAddress(self):
        return 0x401000


class FakeDocumentProvider:
    document = FakeDocument()

    @classmethod
    def getAllDocuments(cls):
        return [cls.document]

    @classmethod
    def getCurrentDocument(cls):
        return cls.document


def load_bridge(path):
    namespace = {
        "__file__": path,
        "__name__": "rea_hopper_bridge",
    }
    source = Path(path).read_text(encoding="utf-8")
    exec(compile(source, path, "exec"), namespace)
    return namespace


def main():
    bridge = load_bridge(sys.argv[1])
    unavailable = None
    try:
        bridge["_api"]()
    except Exception as error:
        unavailable = {
            "type": type(error).__name__,
            "diagnostic_type": bridge["_diagnostic_type"](error),
        }

    bridge["REA_TARGET_PATH"] = "/tmp/rea-hopper-facade-fixture"
    bridge["_configure_hopper_api"](FakeDocumentProvider)
    current = bridge["_dispatch"]("current_document", {})
    current_address = bridge["_dispatch"]("current_address", {})
    selected = bridge["_session_document"]().getDocumentName()

    analysis_guard = None
    try:
        bridge["_dispatch"]("list_procedures", {"offset": 0, "limit": 1})
    except Exception as error:
        analysis_guard = {
            "type": type(error).__name__,
            "diagnostic_type": bridge["_diagnostic_type"](error),
            "message": str(error),
        }

    print(
        json.dumps(
            {
                "imported_without_hopper": unavailable,
                "current_document": current,
                "current_address": current_address,
                "session_document": selected,
                "analysis_guard": analysis_guard,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
