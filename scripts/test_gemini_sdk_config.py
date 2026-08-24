#!/usr/bin/env python3
"""Offline contract check for the exact official Gemini SDK request shapes."""

from automatic_analysis import ApiKey, GeminiGateway, function_schemas


gateway = GeminiGateway([ApiKey("offline-test-key")])
config = gateway._config(tools_enabled=True)
assert config.tools and config.tools[0].function_declarations
assert [item.name for item in config.tools[0].function_declarations] == [
    "read_transcript", "read_scene_index", "read_key_moments", "open_composite"
]
assert config.automatic_function_calling is not None
assert config.automatic_function_calling.disable is True
assert gateway._config(tools_enabled=False).tools is None
assert function_schemas()[-1]["parameters_json_schema"]["required"] == ["filename"]
print("PASS: official Gemini SDK accepts the native ClipForge function declarations and manual tool-call configuration")
