"""Policy checks for the repo-root agent plugin package.

The repository root *is* the plugin: `mcp.json` sits beside the provider
compatibility manifests, and the plugin's skills are
the canonical `skills/` directory rather than a generated copy.

Version fields are deliberately not checked here; `scripts/release/sync-version.mjs`
owns stamping every derived version from the canonical `VERSION` file, and
`--check` enforces it in CI.
"""

from __future__ import annotations

import json
import struct
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
PLUGIN_NAME = "cad"
MARKETPLACE_NAME = "text-to-cad"

CLAUDE_PLUGIN_PATH = REPO_ROOT / ".claude-plugin" / "plugin.json"
CODEX_PLUGIN_PATH = REPO_ROOT / ".codex-plugin" / "plugin.json"
MCP_PATH = REPO_ROOT / "mcp.json"
CODEX_MCP_PATH = REPO_ROOT / ".mcp.json"
MARKETPLACE_PATH = REPO_ROOT / ".claude-plugin" / "marketplace.json"
CODEX_MARKETPLACE_PATH = REPO_ROOT / ".agents" / "plugins" / "marketplace.json"
SKILLS_ROOT = REPO_ROOT / "skills"

# A plugin manifest may point at its skills directory in any of these forms.
VALID_SKILLS_POINTERS = {"./skills/", "./skills", "skills"}

# Codex resolves a repo-root plugin source from exactly these two spellings
# (codex-rs/core-plugins/src/marketplace.rs). Anything else is treated as a
# subdirectory path and would not resolve to the repository root.
VALID_ROOT_SOURCES = {"./", "."}


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


class PluginManifestPolicyTest(unittest.TestCase):
    def test_provider_plugin_manifests_exist_at_the_repo_root(self) -> None:
        for path in (CLAUDE_PLUGIN_PATH, CODEX_PLUGIN_PATH):
            self.assertTrue(
                path.is_file(),
                f"missing plugin manifest: {path.relative_to(REPO_ROOT)}",
            )

    def test_plugin_manifests_name_the_plugin_consistently(self) -> None:
        for path in (CLAUDE_PLUGIN_PATH, CODEX_PLUGIN_PATH):
            manifest = load_json(path)
            self.assertEqual(
                manifest.get("name"),
                PLUGIN_NAME,
                f"{path.relative_to(REPO_ROOT)} must declare name {PLUGIN_NAME!r}",
            )

    def test_plugin_manifests_point_at_the_canonical_skills_directory(self) -> None:
        for path in (CLAUDE_PLUGIN_PATH, CODEX_PLUGIN_PATH):
            manifest = load_json(path)
            self.assertIn(
                manifest.get("skills"),
                VALID_SKILLS_POINTERS,
                f"{path.relative_to(REPO_ROOT)} must point at ./skills/",
            )

    def test_portable_manifest_does_not_shadow_desktop_mcp_discovery(self) -> None:
        # Verified with the real Codex 0.159.0 plugin/read loader: a root
        # portable manifest yields no MCP servers, even with an explicit pointer.
        self.assertFalse(
            (REPO_ROOT / "plugin.json").exists(),
            "Root plugin.json shadows working desktop MCP discovery; verify host support before adding it",
        )

    def test_mcp_server_starts_the_local_cadgen_runtime(self) -> None:
        config = load_json(MCP_PATH)
        version = (REPO_ROOT / "VERSION").read_text(encoding="utf-8").strip()
        self.assertEqual(
            config.get("$schema"),
            "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        )
        self.assertEqual(
            config.get("mcpServers"),
            {"cad_viewer": {"type": "stdio", "command": "uvx", "args": [
                "--isolated", "--from", f"cadgen[mcp]=={version}", "cadgen", "mcp"
            ]}},
        )
        native_server = load_json(CODEX_MCP_PATH)["mcpServers"]["cad_viewer"]
        self.assertEqual(native_server, {
            "command": "uvx",
            "args": ["--isolated", "--from", f"cadgen[mcp]=={version}", "cadgen", "mcp"],
            "cwd": ".",
            "startup_timeout_sec": 300,
        })
        self.assertEqual(load_json(CODEX_PLUGIN_PATH).get("mcpServers"), "./.mcp.json")

    def test_openai_plugin_displays_as_cad(self) -> None:
        interface = load_json(CODEX_PLUGIN_PATH)["interface"]
        self.assertEqual(interface["displayName"], "CAD")
        self.assertLessEqual(len(interface["shortDescription"]), 30)
        for field in ("composerIcon", "logo", "logoDark"):
            artwork = "logo-c.png"
            canonical_logo = (REPO_ROOT / "apps/docs/public/brand" / artwork).read_bytes()
            self.assertEqual(canonical_logo[:8], b"\x89PNG\r\n\x1a\n")
            width, height = struct.unpack(">II", canonical_logo[16:24])
            self.assertEqual(width, height)
            self.assertGreaterEqual(width, 48)
            self.assertEqual(
                (REPO_ROOT / interface[field]).read_bytes(),
                canonical_logo,
                f"{field} must resolve to the canonical {artwork} in the plugin package",
            )

    def test_marketplace_lists_the_plugin_at_the_repository_root(self) -> None:
        marketplace = load_json(MARKETPLACE_PATH)
        self.assertEqual(marketplace.get("name"), MARKETPLACE_NAME)

        plugins = marketplace.get("plugins")
        self.assertIsInstance(plugins, list, "marketplace plugins must be an array")

        entries = [
            entry
            for entry in plugins
            if isinstance(entry, dict) and entry.get("name") == PLUGIN_NAME
        ]
        self.assertEqual(
            len(entries),
            1,
            f"marketplace must contain exactly one {PLUGIN_NAME!r} entry",
        )
        self.assertIn(
            entries[0].get("source"),
            VALID_ROOT_SOURCES,
            "marketplace entry must source the plugin from the repository root",
        )

    def test_codex_marketplace_installs_this_plugin_from_the_root(self) -> None:
        marketplace = load_json(CODEX_MARKETPLACE_PATH)
        self.assertEqual(marketplace["name"], MARKETPLACE_NAME)
        self.assertEqual(marketplace["interface"]["displayName"], "CAD")
        matches = [entry for entry in marketplace["plugins"] if entry.get("name") == PLUGIN_NAME]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["source"], {"source": "local", "path": "./"})

    def test_no_stale_plugin_subdirectory_package_remains(self) -> None:
        # The generated `plugins/cad/skills` copy is what the repo-root move
        # removed. If it reappears, the duplicate would silently go stale.
        self.assertFalse(
            (REPO_ROOT / "plugins").exists(),
            "plugins/ was replaced by the repo-root plugin package",
        )

    def test_every_skill_directory_is_a_loadable_skill(self) -> None:
        # The plugin ships `skills/` directly, so any directory without a
        # SKILL.md would be published as a broken skill.
        for path in sorted(SKILLS_ROOT.iterdir()):
            if not path.is_dir() or path.name.startswith("."):
                continue
            self.assertTrue(
                (path / "SKILL.md").is_file(),
                f"missing skill manifest: skills/{path.name}/SKILL.md",
            )


if __name__ == "__main__":
    unittest.main()
