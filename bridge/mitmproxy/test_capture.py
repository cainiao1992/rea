"""Source-owned tests for the mitmproxy adapter's record projection."""

import importlib.util
import os
import sys
import types
import unittest
from unittest import mock


def load_capture():
    """Load the adapter with fresh mitmproxy stand-ins scoped to its import."""
    fake_mitmproxy = types.ModuleType("mitmproxy")
    fake_mitmproxy.ctx = types.SimpleNamespace()
    fake_mitmproxy.version = types.SimpleNamespace(VERSION="12.2.3")
    fake_io = types.ModuleType("mitmproxy.io")
    fake_io.tnetstring = types.ModuleType("mitmproxy.io.tnetstring")
    stand_ins = {
        "mitmproxy": fake_mitmproxy,
        "mitmproxy.io": fake_io,
        "mitmproxy.io.tnetstring": fake_io.tnetstring,
    }
    spec = importlib.util.spec_from_file_location(
        "rea_mitmproxy_capture", os.path.join(os.path.dirname(__file__), "capture.py")
    )
    module = importlib.util.module_from_spec(spec)
    with mock.patch.dict(sys.modules, stand_ins):
        spec.loader.exec_module(module)
    return module


capture = load_capture()


def location(value, scheme=None):
    state = {"response": {"headers": [[b"Location", value]]}}
    if scheme is not None:
        state["request"] = {"scheme": scheme}
    record = capture.project_record(state, [])
    sidecar = next(
        field for field in record["binary_fields"] if field["pointer"] == "/response/headers/0/1"
    )
    return record["reported"]["response"]["headers"][0][1], sidecar, record["redactions"]


class TransportUserinfoTests(unittest.TestCase):
    def test_ignorable_controls_cannot_hide_authority_credentials(self):
        for control in [b"\t", b"\n", b"\r"]:
            for value in [b"https://" + control + b"/user:pass@host/path", b"ht" + control + b"tps://user:" + control + b"pass@host/path"]:
                with self.subTest(value=value):
                    text, sidecar, redactions = location(value, b"https")
                    self.assertNotIn("user", text)
                    self.assertNotIn("pass", text)
                    self.assertEqual(sidecar["state"], "redacted")
                    self.assertEqual(len(redactions), 1)

    def test_mixed_network_separators_remove_credentials(self):
        for prefix in [b"\\\\", b"/\\", b"\\/"]:
            with self.subTest(prefix=prefix):
                text, sidecar, redactions = location(prefix + b"user:pass@host/path", b"https")
                self.assertEqual(text, prefix.decode("ascii") + "host/path")
                self.assertEqual(sidecar["state"], "redacted")
                self.assertEqual(len(redactions), 1)

    def test_non_special_base_keeps_backslashes_inside_network_authorities(self):
        text, sidecar, redactions = location(b"//user\\name:pass@host/x", b"foo")
        self.assertEqual(text, "//host/x")
        self.assertEqual(sidecar["state"], "redacted")
        self.assertEqual(len(redactions), 1)
        text, sidecar, redactions = location(b"/\\invoice@customer", b"foo")
        self.assertEqual(text, "/\\invoice@customer")
        self.assertEqual(sidecar["state"], "retained")
        self.assertEqual(redactions, [])

    def test_native_request_paths_preserve_origin_form_and_redact_absolute_form(self):
        for value in [b"/\\invoice@customer", b"//invoice@customer", b"\\\\invoice@customer"]:
            with self.subTest(value=value):
                record = capture.project_record({"request": {"path": value}}, [])
                self.assertEqual(record["reported"]["request"]["path"], value.decode("ascii"))
                self.assertEqual(record["binary_fields"][0]["state"], "retained")
                self.assertEqual(record["redactions"], [])
        record = capture.project_record({"request": {"path": b"https://user:pass@host/x"}}, [])
        self.assertEqual(record["reported"]["request"]["path"], "https://host/x")
        self.assertEqual(record["binary_fields"][0]["state"], "redacted")

    def test_same_scheme_locations_preserve_relative_path_text_and_bytes(self):
        for value in [b"https:invoice@customer", b"https:/invoice@customer", b"https:\\invoice@customer"]:
            with self.subTest(value=value):
                text, sidecar, redactions = location(value, b"https")
                self.assertEqual(text, value.decode("ascii"))
                self.assertEqual(sidecar["state"], "retained")
                self.assertEqual(redactions, [])

    def test_location_authorities_still_remove_credentials_with_a_base_scheme(self):
        for value, scheme, expected in [
            (b"https://user:pass@host/path", b"https", "https://host/path"),
            (b"https:\\\\user:pass@host/path", b"https", "https:\\\\host/path"),
            (b"https:user:pass@host/path", b"http", "https:host/path"),
        ]:
            with self.subTest(value=value, scheme=scheme):
                text, sidecar, redactions = location(value, scheme)
                self.assertEqual(text, expected)
                self.assertEqual(sidecar["state"], "redacted")
                self.assertEqual(len(redactions), 1)

    def test_backup_location_uses_its_own_request_scheme(self):
        record = capture.project_record({
            "request": {"scheme": b"http"},
            "backup": {
                "request": {"scheme": b"https"},
                "response": {"headers": [[b"Location", b"https:invoice@customer"]]},
            },
        }, [])
        self.assertEqual(record["reported"]["backup"]["response"]["headers"][0][1], "https:invoice@customer")
        self.assertEqual(record["redactions"], [])

    def test_backslash_ends_a_special_scheme_authority(self):
        text, sidecar, redactions = location(b"https://example.test\\part@tail")
        self.assertEqual(text, "https://example.test\\part@tail")
        self.assertEqual(sidecar["state"], "retained")
        self.assertIsNotNone(sidecar["content_base64"])
        self.assertEqual(redactions, [])

    def test_userinfo_before_a_backslash_is_still_removed(self):
        text, sidecar, redactions = location(b"https://user:pw@example.test\\path")
        self.assertEqual(text, "https://example.test\\path")
        self.assertEqual(sidecar["state"], "redacted")
        self.assertEqual(
            redactions,
            [{"pointer": "/response/headers/0/1", "reason": "transport-credential"}],
        )

    def test_ordinary_userinfo_is_removed(self):
        text, _sidecar, _redactions = location(b"https://user:pw@example.test/a@b")
        self.assertEqual(text, "https://example.test/a@b")

    def test_empty_userinfo_marker_is_removed(self):
        self.assertEqual(
            capture.without_userinfo("https://@host"), "https://host"
        )

    def test_special_schemes_skip_leading_slashes_before_userinfo(self):
        for value, expected in [
            (b"https://\\user:pass@host/path", b"https://\\host/path"),
            (b"https:\\\\user:pass@host/path", b"https:\\\\host/path"),
            (b"https:user:pass@host", b"https:host"),
            (b"//\\user:pass@host", b"//\\host"),
        ]:
            with self.subTest(value=value):
                self.assertEqual(capture.without_userinfo(value), expected)
        text, sidecar, redactions = location(b"https://\\user:pass@host/path")
        self.assertEqual(text, "https://\\host/path")
        self.assertEqual(sidecar["state"], "redacted")
        self.assertEqual(len(redactions), 1)

    def test_file_base_keeps_paths_after_the_fixed_network_boundary(self):
        for value in [b"///u@h", b"////u@h"]:
            with self.subTest(value=value):
                text, sidecar, redactions = location(value, b"file")
                self.assertEqual(text, value.decode("ascii"))
                self.assertEqual(sidecar["state"], "retained")
                self.assertIsNotNone(sidecar["content_base64"])
                self.assertEqual(redactions, [])

    def test_file_urls_keep_path_text(self):
        self.assertEqual(capture.without_userinfo("file:///a@b"), "file:///a@b")

    def test_non_special_schemes_keep_backslashes_in_the_authority(self):
        self.assertEqual(capture.without_userinfo("foo://a\\b@host/x"), "foo://host/x")
        self.assertEqual(capture.without_userinfo(b"//a\\b@host"), b"//a\\b@host")


if __name__ == "__main__":
    unittest.main()
