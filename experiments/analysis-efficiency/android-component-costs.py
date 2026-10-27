"""Count completed Android MCP tasks; estimates do not establish model billing."""
import argparse
import hashlib
import json
from pathlib import Path

import tiktoken


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def inspect(path, encoding):
    report = json.loads((path / "report.json").read_text())
    catalog = json.loads((path / "catalog.json").read_text())
    calls = json.loads((path / "calls.json").read_text())
    assert len(report["runs"]) == 2 and len(calls) == 4
    assert all(run["answer_verified"] and run["calls"] == 2 for run in report["runs"])
    count = lambda text: len(encoding.encode(text, disallowed_special=()))
    inputs = [{key: tool[key] for key in ["name", "description", "inputSchema"]}
              for tool in catalog["tools"]]
    question = (f"For {report['target']}, find the receiver declaring "
                "android.provider.Telephony.SMS_RECEIVED and report its identity, permission, "
                "enabled/process declarations, per-filter priority and source position. "
                "Preserve source coverage and export complete parent Evidence. "
                "Static declarations do not establish runtime behavior.")
    rows = []
    for index, run in enumerate(report["runs"]):
        selected = calls[index * 2:index * 2 + 2]
        assert [call["name"] for call in selected] == ["inspect_android_package", "export_evidence_bundle"]
        assert not any(call["result"].get("isError") for call in selected)
        arguments = sum(count(compact({"name": call["name"], "arguments": call["arguments"]}))
                        for call in selected)
        text = sum(count(block["text"]) for call in selected
                   for block in call["result"]["content"] if block["type"] == "text")
        wire_calls = [{key: call[key] for key in ["name", "arguments", "result"]} for call in selected]
        rows.append({**run, "estimated_tokens": {
            "question": count(question), "input_catalog_once": count(compact(inputs)),
            "arguments": arguments, "text_replies": text,
            "whole_task_text_projection": count(question) + count(compact(inputs)) + arguments + text,
            "sdk_catalog_and_calls": count(compact({"catalog": catalog, "calls": wire_calls})),
        }, "inspection_sdk_reply_bytes": len(compact(selected[0]["result"]).encode()),
            "inspection_sdk_reply_tokens": count(compact(selected[0]["result"]))})
    return {"case": str(path), "mode": report["mode"], "sha256": report["sha256"],
            "runs": rows, "actual_model_usage": None,
            "receipts_sha256": {name: hashlib.sha256((path / name).read_bytes()).hexdigest()
                                for name in ["report.json", "catalog.json", "calls.json"]}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("cases", type=Path, nargs="+")
    args = parser.parse_args()
    encoding = tiktoken.get_encoding("o200k_base")
    records = [inspect(path, encoding) for path in args.cases]
    assert len({record["sha256"] for record in records}) == 1
    args.output.write_text(json.dumps({"tokenizer": f"tiktoken {tiktoken.__version__}",
        "encoding": encoding.name, "scope": "Text projection counts a fixed question, discovered name/description/input schemas once, all RPC arguments and text replies including proof export. Full SDK transport also counts output schemas and structuredContent. Host context injection and model billing are unmeasured.",
        "records": records}, indent=2) + "\n")


if __name__ == "__main__":
    main()
