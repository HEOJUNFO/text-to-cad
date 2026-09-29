"""Serve the CAD extension over stdio or loopback HTTP."""
from __future__ import annotations

import argparse
from pathlib import Path
import sys


def main(argv=None, *, prog=None) -> int:
    parser = argparse.ArgumentParser(prog=prog, description=__doc__)
    parser.add_argument("--root", type=Path, help="restrict every request to this directory (default: cwd plus host-authorized file directories)")
    parser.add_argument("--transport", choices=("stdio", "streamable-http"), default="stdio")
    parser.add_argument("--port", type=int, default=8000, help="loopback HTTP port (default: 8000)")
    parser.add_argument("--ui", type=Path, help="development override for the bundled extension HTML")
    args = parser.parse_args(argv)
    try:
        from cadgen.mcp.server import create_server
    except ModuleNotFoundError as error:
        if error.name != "mcp":
            raise
        parser.error("CAD MCP requires the optional SDK: pip install 'cadgen[mcp]'")
    try:
        server = create_server(args.root, ui_path=args.ui, port=args.port)
        server.run(transport=args.transport)
    except (OSError, ValueError) as error:
        print(f"CAD MCP: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
