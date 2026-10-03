"""The public ``harness`` namespace: the ``@harness`` decorator and the harness API.

``@harness`` DECLARES a wiring harness model; ``harness.Harness`` is what its
function builds and returns, with ``Connector``, ``Cable``, ``Wire`` and
``Pin`` its parts and ``HarnessError`` its refusals. They are the same object
-- this module is callable (see :mod:`cadgen._internal.format_namespace`) --
so ``from cadgen import harness`` gives a model script all of them.

A harness is written as one WireViz document, ``<name>.harness.yml``, after
its checks pass: a wire whose ends are on boards joins pins carrying the same
net, a pin takes one wire, every colour, gauge and length is one WireViz
reads. WireViz itself -- a separate program cadgen runs and never imports --
draws the document for the CAD Viewer and lists its bill of materials
(``@bom`` above ``@harness``, or ``cadgen bom build``).

Import discipline: nothing here pulls in OCP or runs WireViz at module scope.
"""

from __future__ import annotations

from cadgen._internal.format_namespace import callable_namespace

__all__ = ["Cable", "Connector", "Harness", "HarnessError", "Pin", "Wire"]

_DESIGN = frozenset(__all__)


def __getattr__(name: str):
    if name in _DESIGN:
        from cadgen.wireviz import design

        return getattr(design, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


callable_namespace(__name__, "harness")
