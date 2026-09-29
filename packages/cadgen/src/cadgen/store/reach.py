"""Static reach inside one module: the top-level statements a build can execute
through the names it takes from the module, and a hash over exactly those.

A helper module is tracked by the names a model reaches in it (``STORE.md`` §3,
"functions by reach"). This module answers two questions about ONE file's bytes
and nothing else — no filesystem, no import resolution, no model detection —
so the same bytes always analyse the same way:

- :func:`analyze` splits the module into top-level **statements**, each with
  the module-scope names it binds and reads, the attribute chains it walks on
  those names, the imports it contains, and its own AST dump. A statement is a
  **definition** (a ``def``, a ``class`` or a plain-name assignment whose
  import-time evaluation is inert) or **preamble** (everything else: imports,
  calls, conditionals, loops, attribute writes, decorated definitions, defaults
  that call — anything that runs or may register something at import).
  Preamble is always part of a slice; a definition is part of it only when a
  reached name binds it.
- :func:`close_names` expands a set of reached names within the module: a
  reached definition's reads reach the definitions they name, transitively.
- :func:`slice_hash` hashes preamble + the reached definitions in source
  order, with the reached names and whether each is bound. It is comment- and
  formatting-insensitive like the whole-file semantic hash.

**Anything dynamic makes the whole module the slice** (``ModuleSyntax.dynamic``
names why): a star import, ``exec``/``eval``/``compile``/``__import__``,
``globals()``/``locals()``, ``importlib``/``sys.modules``, a module-level
``__getattr__``, or a name that resolves to nothing the analysis can see. Uses
that reach OUT of the module — a module alias used bare (``getattr(geo, n)``,
``vars(geo)``, passing ``geo`` along) or written to (``geo.X = 1``) — are
reported per statement (``bare``, ``stores``) for the closure walk to turn into
whole-file edges on the target.
"""

from __future__ import annotations

import ast
import builtins
import hashlib
import symtable
from dataclasses import dataclass
from typing import Iterable, Mapping

_BUILTIN_NAMES = frozenset(dir(builtins)) | frozenset({
    "__file__", "__name__", "__doc__", "__spec__", "__package__", "__loader__",
    "__path__", "__builtins__", "__annotations__", "__cached__", "__all__",
    "__class__", "__qualname__", "__module__", "__debug__",
})
# Reading one of these at all makes the module's namespace unanalysable.
_DYNAMIC_NAMES = frozenset({"globals", "locals", "exec", "eval", "compile", "__import__"})
# Any binding taken from one of these modules is a dynamic import surface.
_DYNAMIC_MODULES = frozenset({"importlib", "builtins", "runpy", "pkgutil"})
# Decorators whose application is a pure wrapping: the decorated definition stays
# a definition. Every other decorator may register its target somewhere at import
# time, which makes the definition preamble (always hashed, its reads reached).
_PURE_DECORATOR_MODULES = frozenset({"cadgen", "functools", "dataclasses", "typing", "contextlib", "enum", "abc"})
_PURE_DECORATOR_BUILTINS = frozenset({"staticmethod", "classmethod", "property"})
# Calls that construct or compute and touch no module state: a module-level
# assignment whose every call is one of these is a definition (``COLOR =
# srgb("#fff")``, ``R = math.hypot(3, 4)``, ``AXIS = bd.Vector(0, 0, 1)``), not
# preamble. Any other call may register something at import and stays preamble.
_PURE_CALL_MODULES = frozenset({
    "math", "cmath", "cadgen", "build123d", "OCP", "numpy", "operator", "itertools", "functools",
    "dataclasses", "enum", "typing", "collections", "fractions", "decimal", "string", "re",
})
_PURE_BUILTIN_CALLS = frozenset({
    "abs", "all", "any", "bool", "bytes", "callable", "chr", "complex", "dict", "divmod", "enumerate",
    "filter", "float", "format", "frozenset", "hash", "hex", "int", "isinstance", "issubclass", "iter",
    "len", "list", "map", "max", "min", "next", "oct", "ord", "pow", "range", "repr", "reversed", "round",
    "set", "slice", "sorted", "str", "sum", "tuple", "type", "zip",
})
_MODULE_HOOKS = frozenset({"__getattr__", "__dir__"})


@dataclass(frozen=True)
class Alias:
    """One name an import statement binds."""

    module: str          # dotted module; "" for ``from . import x``
    level: int           # relative-import level
    attr: str | None     # the name ``from module import attr`` takes; None for ``import module``


@dataclass(frozen=True)
class Statement:
    index: int
    definition: bool
    binds: tuple[str, ...]                                      # module-scope names this statement binds
    reads: tuple[str, ...]                                      # names read bare, module-scope resolved
    chains: tuple[tuple[str, tuple[str, ...]], ...]             # (name, attribute chain) reads
    stores: tuple[str, ...]                                     # names whose attribute is written or deleted
    aliases: tuple[tuple[str, Alias], ...]                      # import bindings inside this statement
    stars: tuple[Alias, ...]                                    # star imports inside this statement
    dump: str


@dataclass(frozen=True)
class ModuleSyntax:
    statements: tuple[Statement, ...]
    definitions: Mapping[str, tuple[int, ...]]   # name -> definition statements binding it
    preamble: tuple[int, ...]                    # statement indices that are always in the slice
    preamble_bound: frozenset[str]               # names a preamble statement binds
    aliases: Mapping[str, tuple[Alias, ...]]     # module-scope import bindings (top level + inside preamble)
    dynamic: str | None                          # why the whole module must be tracked, or None
    # The dynamism can reach into other modules (exec/eval/importlib/sys.modules):
    # every module this one imports is tracked whole too, not only this one.
    unbounded: bool
    whole_hash: str                              # the whole-file semantic hash of these bytes

    @property
    def imports(self) -> tuple[tuple[str, Alias], ...]:
        return tuple((name, alias) for name, aliases in self.aliases.items() for alias in aliases)

    def taken(self, name: str) -> set[str] | None:
        """Attribute names the whole module takes from the binding ``name``;
        None when it is used bare somewhere (the file-level view)."""
        taken: set[str] = set()
        for statement in self.statements:
            if name in statement.reads or name in statement.stores:
                return None
            for base, chain in statement.chains:
                if base == name:
                    if not chain:
                        return None
                    taken.add(chain[0])
        return taken


# --- per-statement facts ----------------------------------------------------------


def _bound_names(node: ast.AST) -> tuple[set[str], set[str]]:
    """(names bound by ordinary binding, names bound by an import) in the subtree."""
    plain: set[str] = set()
    imported: set[str] = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Name) and isinstance(child.ctx, (ast.Store, ast.Del)):
            plain.add(child.id)
        elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            plain.add(child.name)
        elif isinstance(child, ast.arg):
            plain.add(child.arg)
        elif isinstance(child, ast.ExceptHandler) and child.name:
            plain.add(child.name)
        elif isinstance(child, ast.MatchAs) and child.name:
            plain.add(child.name)
        elif isinstance(child, ast.MatchStar) and child.name:
            plain.add(child.name)
        elif isinstance(child, ast.MatchMapping) and child.rest:
            plain.add(child.rest)
        elif isinstance(child, ast.Import):
            imported.update(alias.asname or alias.name.split(".")[0] for alias in child.names)
        elif isinstance(child, ast.ImportFrom):
            imported.update(alias.asname or alias.name for alias in child.names if alias.name != "*")
    return plain, imported


def _import_aliases(node: ast.AST) -> tuple[list[tuple[str, Alias]], list[Alias]]:
    aliases: list[tuple[str, Alias]] = []
    stars: list[Alias] = []
    for child in ast.walk(node):
        if isinstance(child, ast.Import):
            for alias in child.names:
                if alias.asname:
                    aliases.append((alias.asname, Alias(alias.name, 0, None)))
                else:
                    aliases.append((alias.name.split(".")[0], Alias(alias.name.split(".")[0], 0, None)))
        elif isinstance(child, ast.ImportFrom):
            module = child.module or ""
            for alias in child.names:
                if alias.name == "*":
                    stars.append(Alias(module, child.level, None))
                else:
                    aliases.append((alias.asname or alias.name, Alias(module, child.level, alias.name)))
    return aliases, stars


def _module_reads(node: ast.AST) -> set[str]:
    """Conservatively union module reads across lexical scopes in a statement.

    Python resolves defaults/decorators in the enclosing scope, and gives
    nested functions and comprehensions their own bindings. A subtree-wide
    set of locals loses e.g. the outer WIDTH in ``def f(WIDTH=WIDTH)``.
    Class bodies use LOAD_NAME and may fall back to the module even for a
    locally bound name, so retain all their reads. Imported locals also stay
    visible so the closure walker can follow their statement-local aliases.
    """
    pending = [symtable.symtable(ast.unparse(node), "<reach>", "exec")]
    names: set[str] = set()
    while pending:
        table = pending.pop()
        for symbol in table.get_symbols():
            if symbol.is_declared_global() or symbol.is_imported() or (symbol.is_referenced() and (
                table.get_type() in ("module", "class") or symbol.is_global()
            )):
                names.add(symbol.get_name())
        pending.extend(table.get_children())
    return names


def _reads(node: ast.AST) -> tuple[list[str], list[tuple[str, tuple[str, ...]]], list[str]]:
    """Bare reads, attribute-chain reads and attribute-stores of module-scope names."""
    visible = _module_reads(node)
    chained: dict[int, tuple[str, ...]] = {}
    stores: set[str] = set()
    for child in ast.walk(node):
        if not isinstance(child, ast.Attribute):
            continue
        chain: list[str] = []
        base: ast.AST = child
        while isinstance(base, ast.Attribute):
            chain.append(base.attr)
            base = base.value
        if not isinstance(base, ast.Name):
            continue
        if isinstance(child.ctx, (ast.Store, ast.Del)):
            if base.id in visible:
                stores.add(base.id)
            continue
        # ast.walk is breadth-first from the outermost node, so the first chain
        # recorded for a base Name is the longest one.
        chained.setdefault(id(base), tuple(reversed(chain)))
    reads: set[str] = set()
    chains: set[tuple[str, tuple[str, ...]]] = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Global):
            reads.update(child.names)
        if not (isinstance(child, ast.Name) and isinstance(child.ctx, ast.Load)):
            continue
        if child.id not in visible:
            continue
        chain = chained.get(id(child))
        if chain is None:
            reads.add(child.id)
        else:
            chains.add((child.id, chain))
    return sorted(reads), sorted(chains), sorted(stores)


_LITERAL_ROOTS = (ast.Constant, ast.List, ast.Tuple, ast.Dict, ast.Set, ast.JoinedStr,
                  ast.ListComp, ast.DictComp, ast.SetComp, ast.GeneratorExp, ast.BinOp, ast.UnaryOp)


def _pure_call(call: ast.Call, aliases: Mapping[str, tuple[Alias, ...]], module_defined: set[str]) -> bool:
    """Whether this call can only construct or compute: a pure builtin, a name
    from a pure module, an attribute chain rooted there, or a method on a
    literal or on another pure call. A call on the module's own objects is not
    (``REGISTRY.setdefault(...)`` mutates)."""
    root: ast.AST = call.func
    while isinstance(root, ast.Attribute):
        root = root.value
    if isinstance(root, ast.Name):
        if root.id in module_defined:
            return False
        bound = aliases.get(root.id)
        if bound:
            return all(alias.level == 0 and alias.module.split(".")[0] in _PURE_CALL_MODULES for alias in bound)
        return root is call.func and root.id in _PURE_BUILTIN_CALLS
    if isinstance(root, ast.Call):
        return _pure_call(root, aliases, module_defined)
    return isinstance(root, _LITERAL_ROOTS)


def _inert(nodes: Iterable[ast.AST], aliases: Mapping[str, tuple[Alias, ...]], module_defined: set[str]) -> bool:
    """Whether evaluating these expressions at import can touch module state."""
    for node in nodes:
        for child in ast.walk(node):
            if isinstance(child, (ast.Await, ast.Yield, ast.YieldFrom)):
                return False
            if isinstance(child, ast.Call) and not _pure_call(child, aliases, module_defined):
                return False
    return True


def _is_main_guard(node: ast.stmt) -> bool:
    """``if __name__ == "__main__":`` — never runs on import, so never in a slice."""
    if not isinstance(node, ast.If) or not isinstance(node.test, ast.Compare):
        return False
    test = node.test
    if len(test.ops) != 1 or not isinstance(test.ops[0], ast.Eq) or len(test.comparators) != 1:
        return False
    sides = (test.left, test.comparators[0])
    return (any(isinstance(s, ast.Name) and s.id == "__name__" for s in sides)
            and any(isinstance(s, ast.Constant) and s.value == "__main__" for s in sides)
            and not node.orelse)


def _decorator_is_pure(decorator: ast.AST, aliases: Mapping[str, tuple[Alias, ...]]) -> bool:
    callee = decorator.func if isinstance(decorator, ast.Call) else decorator
    while isinstance(callee, ast.Attribute):
        callee = callee.value
    if not isinstance(callee, ast.Name):
        return False
    if callee.id in _PURE_DECORATOR_BUILTINS and callee.id not in aliases:
        return True
    bound = aliases.get(callee.id)
    if not bound:
        return False
    return all(alias.level == 0 and alias.module.split(".")[0] in _PURE_DECORATOR_MODULES for alias in bound)


def _simple_targets(targets: Iterable[ast.AST]) -> list[str] | None:
    names: list[str] = []
    for target in targets:
        if isinstance(target, ast.Name):
            names.append(target.id)
        elif isinstance(target, (ast.Tuple, ast.List)):
            inner = _simple_targets(target.elts)
            if inner is None:
                return None
            names.extend(inner)
        elif isinstance(target, ast.Starred):
            inner = _simple_targets([target.value])
            if inner is None:
                return None
            names.extend(inner)
        else:
            return None
    return names


def _classify(
    node: ast.stmt, aliases: Mapping[str, tuple[Alias, ...]], first_party_bases: set[str], module_defined: set[str],
) -> tuple[bool, list[str]]:
    """(is a definition, the names it defines). Preamble binds are collected separately."""
    if _is_main_guard(node):
        return True, []  # a definition binding nothing: never in a slice
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        if any(not _decorator_is_pure(d, aliases) for d in node.decorator_list):
            return False, [node.name]
        args = node.args
        evaluated = [*args.defaults, *[d for d in args.kw_defaults if d is not None],
                     *[a.annotation for a in (*args.posonlyargs, *args.args, *args.kwonlyargs) if a.annotation is not None],
                     *([args.vararg.annotation] if args.vararg is not None and args.vararg.annotation is not None else []),
                     *([args.kwarg.annotation] if args.kwarg is not None and args.kwarg.annotation is not None else []),
                     *([node.returns] if node.returns is not None else [])]
        if not _inert(evaluated, aliases, module_defined):
            return False, [node.name]
        return True, [node.name]
    if isinstance(node, ast.ClassDef):
        if node.keywords or any(not _decorator_is_pure(d, aliases) for d in node.decorator_list):
            return False, [node.name]
        for base in node.bases:
            root: ast.AST = base
            while isinstance(root, ast.Attribute):
                root = root.value
            if not isinstance(root, ast.Name) or root.id in first_party_bases:
                return False, [node.name]
            bound = aliases.get(root.id)
            if bound is None and root.id not in _BUILTIN_NAMES:
                return False, [node.name]
        body_level = [child for child in node.body if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))]
        if not _inert(body_level, aliases, module_defined):
            return False, [node.name]
        return True, [node.name]
    if isinstance(node, ast.Assign):
        names = _simple_targets(node.targets)
    elif isinstance(node, ast.AnnAssign):
        names = _simple_targets([node.target]) if node.value is not None else None
    elif isinstance(node, ast.AugAssign):
        names = _simple_targets([node.target])
    else:
        return False, []
    if names is None:
        return False, []
    value = node.value
    if value is not None and not _inert([value], aliases, module_defined):
        return False, names
    return True, names


# --- the module ------------------------------------------------------------------


def analyze(source: bytes, filename: str = "<module>") -> ModuleSyntax:
    """Analyse one module's bytes. Raises ``SyntaxError``/``ValueError`` like
    ``ast.parse`` on invalid source (the caller hashes such bytes whole)."""
    tree = ast.parse(source, filename=filename)
    whole_hash = "ast1:" + hashlib.sha256(ast.dump(tree).encode("utf-8")).hexdigest()
    dynamic: str | None = None
    unbounded = False

    # Module-scope import bindings: every import outside a function body. Inside a
    # definition they are that statement's own aliases.
    module_aliases: dict[str, list[Alias]] = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        aliases, stars = _import_aliases(node)
        for name, alias in aliases:
            module_aliases.setdefault(name, []).append(alias)
        if stars:
            dynamic = dynamic or "star import"
    frozen_aliases: dict[str, tuple[Alias, ...]] = {name: tuple(v) for name, v in module_aliases.items()}
    for name, bound in frozen_aliases.items():
        if any(alias.level == 0 and alias.module.split(".")[0] in _DYNAMIC_MODULES for alias in bound):
            dynamic = dynamic or f"dynamic import surface: {name}"
            unbounded = True

    # A first pass over binds decides which class bases are first-party names
    # (a class deriving from a project class may register through its metaclass).
    module_defined: set[str] = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            module_defined.add(node.name)
        else:
            plain, _imported = _bound_names(node)
            module_defined.update(plain)
    first_party_bases = module_defined | {name for name, bound in frozen_aliases.items()
                                          if any(alias.level > 0 or alias.module.split(".")[0] not in _PURE_DECORATOR_MODULES
                                                 for alias in bound)}

    statements: list[Statement] = []
    definitions: dict[str, list[int]] = {}
    preamble: list[int] = []
    preamble_bound: set[str] = set()
    for index, node in enumerate(tree.body):
        definition, defined = _classify(node, frozen_aliases, first_party_bases, module_defined)
        plain, imported = _bound_names(node)
        # Every import in the statement: local to a definition's body, module-scope
        # (and already in ``module_aliases``) for a preamble statement. Listed on
        # the statement either way so reaching it executes the imported modules.
        local_aliases, stars = _import_aliases(node)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            # The definition's own name is module-scope; what it binds inside is
            # local — except names its own imports bind, which stay visible as
            # reads so the walk can follow them through the statement's aliases.
            binds = [node.name]
        elif definition:
            # A plain assignment: what its comprehensions, lambdas and walruses
            # bind is local to the expression; only the targets are module-scope.
            binds = list(defined)
        else:
            # Preamble binds everything it binds at module scope (a loop
            # variable, a conditional import, a definition inside an ``if``).
            binds = sorted(plain | imported)
        reads, chains, stores = _reads(node)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in _MODULE_HOOKS:
            dynamic = dynamic or f"module hook {node.name}"
        for name in reads:
            if name in _DYNAMIC_NAMES and name not in module_defined and name not in frozen_aliases:
                dynamic = dynamic or f"{name}()"
                unbounded = unbounded or name not in ("globals", "locals")
        for base, chain in chains:
            if base == "sys" and chain[:1] == ("modules",) and base in frozen_aliases:
                dynamic = dynamic or "sys.modules"
                unbounded = True
        for _name, alias in local_aliases:
            if alias.level == 0 and alias.module.split(".")[0] in _DYNAMIC_MODULES:
                dynamic = dynamic or f"dynamic import surface: {alias.module}"
                unbounded = True
        if stars:
            dynamic = dynamic or "star import"
        statements.append(Statement(
            index=index, definition=definition, binds=tuple(binds), reads=tuple(reads),
            chains=tuple(chains), stores=tuple(stores), aliases=tuple(local_aliases),
            stars=tuple(stars), dump=ast.dump(node),
        ))
        if definition:
            for name in binds:
                definitions.setdefault(name, []).append(index)
        else:
            preamble.append(index)
            preamble_bound.update(binds)

    # Unresolved names: a read that nothing binds and no builtin answers.
    if dynamic is None:
        for statement in statements:
            local_alias_names = {name for name, _alias in statement.aliases}
            for name in (*statement.reads, *(base for base, _chain in statement.chains), *statement.stores):
                if (name in definitions or name in preamble_bound or name in frozen_aliases
                        or name in local_alias_names or name in _BUILTIN_NAMES):
                    continue
                dynamic = f"unresolved name {name}"
                break
            if dynamic is not None:
                break

    return ModuleSyntax(
        statements=tuple(statements),
        definitions={name: tuple(v) for name, v in definitions.items()},
        preamble=tuple(preamble),
        preamble_bound=frozenset(preamble_bound),
        aliases=frozen_aliases,
        dynamic=dynamic,
        unbounded=unbounded,
        whole_hash=whole_hash,
    )


def close_names(syntax: ModuleSyntax, names: Iterable[str]) -> frozenset[str]:
    """The reached names closed within the module: every definition a reached
    definition reads, transitively. Preamble reads are roots of every slice."""
    reached: set[str] = set()
    pending: list[str] = list(names)
    for index in syntax.preamble:
        pending.extend(_definition_reads(syntax.statements[index]))
    while pending:
        name = pending.pop()
        if name in reached:
            continue
        reached.add(name)
        for index in syntax.definitions.get(name, ()):
            pending.extend(_definition_reads(syntax.statements[index]))
    return frozenset(reached)


def _definition_reads(statement: Statement) -> Iterable[str]:
    yield from statement.reads
    for base, _chain in statement.chains:
        yield base
    yield from statement.stores


def slice_hash(syntax: ModuleSyntax, names: Iterable[str]) -> str:
    """The hash the gate compares for a sliced file: preamble plus every
    definition a name in the closed set binds, in source order, with the names
    and whether each is bound. The whole-file semantic hash when the module is
    dynamic, so a record sliced before the module turned dynamic reads stale."""
    if syntax.dynamic is not None:
        return syntax.whole_hash
    closed = close_names(syntax, names)
    # v2 invalidates records made before import aliases in separate nested
    # scopes were all retained. Re-slicing their old name lists cannot recover
    # a cross-module edge that was never recorded; they must rebuild once.
    digest = hashlib.sha256(b"slice2")
    for name in sorted(closed):
        digest.update(b"\0" + name.encode("utf-8") + (b"=" if name in syntax.definitions else b"!"))
    for statement in syntax.statements:
        if not statement.definition or any(name in closed for name in statement.binds):
            digest.update(b"\0\0" + statement.dump.encode("utf-8"))
    return "slice2:" + digest.hexdigest()
