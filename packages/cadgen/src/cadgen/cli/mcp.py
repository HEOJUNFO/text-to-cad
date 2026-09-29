"""Serve the CAD extension over stdio or loopback HTTP."""
from __future__ import annotations

import argparse
from pathlib import Path
import sys

from cadgen.assets import AssetMissing


def main(argv=None, *, prog=None) -> int:
    parser = argparse.ArgumentParser(prog=prog, description=__doc__)
    parser.add_argument("--transport", choices=("stdio", "streamable-http"), default="stdio")
    parser.add_argument("--port", type=int, default=8000, help="loopback HTTP port (default: 8000)")
    parser.add_argument("--ui", type=Path, help="development override for the bundled extension HTML")
    arguments = list(sys.argv[1:] if argv is None else argv)
    if any(argument == "--root" or argument.startswith("--root=") for argument in arguments):
        parser.error("--root is retired; open an absolute CAD file path with cad_open instead")
    args = parser.parse_args(arguments)
    try:
        from cadgen.mcp.server import create_server
    except ModuleNotFoundError as error:
        if error.name != "mcp":
            raise
        parser.error("CAD MCP requires the optional SDK: pip install 'cadgen[mcp]'")
    try:
        server = create_server(ui_path=args.ui, port=args.port)
        server.run(transport=args.transport)
    except (AssetMissing, OSError, ValueError) as error:
        print(f"CAD MCP: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
