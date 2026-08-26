"""Offline tests for pipeline/diagnostics/gemini.py (§12 Gemini capability check).

The google-genai SDK is NOT installed in the test environment, so these tests
stub the ``google.genai`` modules before importing the diagnostic and drive a
fake Client through probe_key()/main(). No test makes a real network call.
"""

from __future__ import annotations

import json
import os
import sys
import types as _types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock


def _install_fake_genai(*, available_models=("gemini-3.7-flash",), probe_ok=True):
    """Install a stub google.genai into sys.modules and return the Client class."""
    genai = _types.ModuleType("google.genai")
    genai.__path__ = []
    gtypes = _types.ModuleType("google.genai.types")

    class _NS:
        def __init__(self, *a, **k):
            for key, value in k.items():
                setattr(self, key, value)

    for name in (
        "FunctionDeclaration", "GenerateContentConfig", "Tool", "ToolConfig",
        "FunctionCallingConfig", "AutomaticFunctionCallingConfig", "Content",
    ):
        setattr(gtypes, name, type(name, (_NS,), {}))

    class Part(_NS):
        @classmethod
        def from_text(cls, *, text):
            return cls(text=text)

        @classmethod
        def from_bytes(cls, *, data, mime_type):
            return cls(data=data, mime_type=mime_type)

    gtypes.Part = Part
    genai.types = gtypes

    class _Model:
        def __init__(self, name):
            self.name = name

    class _Models:
        def __init__(self, outer):
            self._outer = outer

        def list(self):
            return [_Model(f"models/{m}") for m in self._outer._available]

        def generate_content(self, model=None, contents=None, config=None):
            return self._outer._generate(model)

    class Client:
        def __init__(self, api_key=None):
            self._available = available_models
            self.models = _Models(self)

        def _generate(self, model):
            if not probe_ok:
                raise RuntimeError("probe exploded")
            call = _types.SimpleNamespace(
                name="echo_evidence", args={"label": "direct_api_vision_tool_probe"}
            )
            return _types.SimpleNamespace(function_calls=[call])

    genai.Client = Client
    google = _types.ModuleType("google")
    google.genai = genai
    google.__path__ = []
    return {
        "google": google,
        "google.genai": genai,
        "google.genai.types": gtypes,
    }


def _import_gemini(modules):
    with mock.patch.dict(sys.modules, modules):
        sys.modules.pop("pipeline.diagnostics.gemini", None)
        import importlib

        return importlib.import_module("pipeline.diagnostics.gemini")


class LoadKeysTests(unittest.TestCase):
    def setUp(self):
        self.gemini = _import_gemini(_install_fake_genai())

    def test_splits_comma_and_newline_and_dedupes(self):
        keys = self.gemini.load_keys("AIzaAAA, AIzaBBB\nAIzaAAA\r\n  AIzaCCC ")
        self.assertEqual([k.raw for k in keys], ["AIzaAAA", "AIzaBBB", "AIzaCCC"])

    def test_fingerprints_are_stable_and_prefixed(self):
        keys = self.gemini.load_keys("AIzaAAA,AIzaBBB")
        self.assertTrue(all(k.fingerprint.startswith("key-") for k in keys))
        self.assertEqual(len({k.fingerprint for k in keys}), 2)
        # Fingerprints never contain the raw key material.
        for key in keys:
            self.assertNotIn(key.raw, key.fingerprint)

    def test_empty_raises(self):
        with self.assertRaises(RuntimeError):
            self.gemini.load_keys("  , ,\n")


class ErrorMetadataTests(unittest.TestCase):
    def setUp(self):
        self.gemini = _import_gemini(_install_fake_genai())

    def test_redacts_gemini_keys_and_secret_fields(self):
        err = Exception("bad AIzaSECRET123 api_key=abc123 token: xyz")
        meta = self.gemini.error_metadata(err)
        self.assertIn("AIza[REDACTED]", meta["message"])
        self.assertIn("api_key=[REDACTED]", meta["message"])
        self.assertIn("token: [REDACTED]", meta["message"])
        self.assertEqual(meta["status"], None)
        self.assertEqual(meta["type"], "Exception")

    def test_status_from_code_attribute(self):
        err = Exception("nope")
        err.code = 429
        self.assertEqual(self.gemini.error_metadata(err)["status"], 429)


class ProbeKeyTests(unittest.TestCase):
    def test_successful_probe(self):
        gemini = _import_gemini(_install_fake_genai(available_models=("gemini-3.7-flash",)))
        result = gemini.probe_key(gemini.ApiKey(raw="AIzaAAA", fingerprint="key-x"))
        self.assertTrue(result["success"])
        self.assertTrue(result["native_function_calling"])
        self.assertTrue(result["inline_image_input"])
        self.assertEqual(result["selected_model"], "gemini-3.7-flash")
        self.assertNotIn("error", result)

    def test_no_configured_model_visible(self):
        gemini = _import_gemini(_install_fake_genai(available_models=("some-other-model",)))
        result = gemini.probe_key(gemini.ApiKey(raw="AIzaAAA", fingerprint="key-x"))
        self.assertFalse(result["success"])
        self.assertEqual(result["error"]["type"], "NoConfiguredModel")

    def test_probe_exception_recorded_redacted(self):
        gemini = _import_gemini(_install_fake_genai(available_models=("gemini-3.7-flash",), probe_ok=False))
        result = gemini.probe_key(gemini.ApiKey(raw="AIzaAAA", fingerprint="key-x"))
        self.assertFalse(result["success"])
        self.assertEqual(result["error"]["type"], "RuntimeError")
        self.assertNotIn("AIzaAAA", json.dumps(result))

    def test_model_candidates_match_automatic_mode(self):
        gemini = _import_gemini(_install_fake_genai())
        from pipeline.plan.automatic import DEFAULT_FALLBACK_MODELS, DEFAULT_PRIMARY_MODEL

        self.assertEqual(
            gemini.MODEL_CANDIDATES, (DEFAULT_PRIMARY_MODEL, *DEFAULT_FALLBACK_MODELS)
        )


class MainTests(unittest.TestCase):
    def test_writes_report_and_exit_code(self):
        gemini = _import_gemini(_install_fake_genai())
        with TemporaryDirectory() as tmp:
            out = Path(tmp) / "report.json"
            with (
                mock.patch.dict(os.environ, {"GEMINI_API_KEYS": "AIzaAAA,AIzaBBB"}),
                mock.patch.object(sys, "argv", ["gemini", "--output", str(out)]),
            ):
                code = gemini.main()
            self.assertEqual(code, 0)
            report = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(report["version"], 1)
            self.assertEqual(report["successful_keys"], 2)
            self.assertEqual(len(report["keys"]), 2)
            self.assertNotIn("AIzaAAA", out.read_text(encoding="utf-8"))

    def test_all_keys_failing_returns_1(self):
        gemini = _import_gemini(_install_fake_genai(available_models=("other",)))
        with TemporaryDirectory() as tmp:
            out = Path(tmp) / "report.json"
            with (
                mock.patch.dict(os.environ, {"GEMINI_API_KEYS": "AIzaAAA"}),
                mock.patch.object(sys, "argv", ["gemini", "--output", str(out)]),
            ):
                code = gemini.main()
            self.assertEqual(code, 1)

    def test_missing_keys_env_returns_1(self):
        gemini = _import_gemini(_install_fake_genai())
        with TemporaryDirectory() as tmp:
            out = Path(tmp) / "report.json"
            with (
                mock.patch.dict(os.environ, {}, clear=True),
                mock.patch.object(sys, "argv", ["gemini", "--output", str(out)]),
            ):
                code = gemini.main()
            self.assertEqual(code, 1)
            self.assertFalse(out.exists())


if __name__ == "__main__":
    unittest.main()
