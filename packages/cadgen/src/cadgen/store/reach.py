"""Static reach inside one module: the top-level statements a build can execute
through the names it takes from the module, and a hash over exactly those.

A helper module is tracked by the names a model reaches in it (``STORE.md`` §3,
"functions by reach"). This module answers two questions about ONE file's bytes
and nothing else — no filesystem, no import resolution, no model detection —
so the same bytes always analyse the same way:

- :func:`analyze` splits the module into top-level **statements**, each with
  the module-scope names it binds and reads, the attribute chains it walks on
  those names, the imports it contains, and its own AST dump. A statement is a
  **definition** (an undecorated ``def`` with inert defaults/annotations,
  or a single-name literal assignment without rebinding) or **preamble**
  (everything else: imports,
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


def _module_bindings(node: ast.stmt) -> set[str]:
    """Possible namespace writes, excluding ordinary function/class locals."""
    top = symtable.symtable(ast.unparse(node), "<reach>", "exec")
    names = {symbol.get_name() for symbol in top.get_symbols()
             if symbol.is_assigned() or symbol.is_imported()}
    pending = list(top.get_children())
    while pending:
        table = pending.pop()
        names.update(symbol.get_name() for symbol in table.get_symbols()
                     if symbol.is_declared_global() and (symbol.is_assigned() or symbol.is_imported()))
        pending.extend(table.get_children())
    return names


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


def _literal(node: ast.AST) -> bool:
    """Closed literal syntax, without names or Python protocol dispatch.

    Do not infer purity from a callable's module or from the absence of Calls:
    attributes, operators, unpacking, formatting and conversions can all run
    user code. New expression syntax is non-inert until explicitly handled.
    """
    if isinstance(node, ast.Constant):
        return True
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return all(_literal(item) for item in node.elts)
    if isinstance(node, ast.Dict):
        return all(key is not None and _literal(key) and _literal(value)
                   for key, value in zip(node.keys, node.values))
    return (isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub))
            and isinstance(node.operand, ast.Constant)
            and type(node.operand.value) in (int, float, complex))


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


def _classify(node: ast.stmt, rebound: set[str]) -> tuple[bool, list[str]]:
    """Only deferred function bodies and closed literals may be omitted.

    Everything else executes as preamble, including all classes/decorators,
    annotations on assignments, calls, aliases and augmented assignments.
    Even inert evaluation can release an old value on rebinding (__del__), so
    repeated bindings cannot be omitted either.
    """
    if _is_main_guard(node) and "__name__" not in rebound:
        return True, []  # never runs on import
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        if node.name in rebound or node.decorator_list or getattr(node, "type_params", ()):
            return False, [node.name]
        args = node.args
        evaluated = [*args.defaults, *[d for d in args.kw_defaults if d is not None],
                     *[a.annotation for a in (*args.posonlyargs, *args.args, *args.kwonlyargs) if a.annotation is not None],
                     *([args.vararg.annotation] if args.vararg is not None and args.vararg.annotation is not None else []),
                     *([args.kwarg.annotation] if args.kwarg is not None and args.kwarg.annotation is not None else []),
                     *([node.returns] if node.returns is not None else [])]
        # Even a bare name can retain an object in defaults/annotations and
        # change when its finalizer runs. Only closed literals are optional.
        return all(_literal(value) for value in evaluated), [node.name]
    if (isinstance(node, ast.Assign) and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)):
        name = node.targets[0].id
        return name not in rebound and _literal(node.value), [name]
    return False, []


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

    # Count possible namespace writes, including conditional/global writes.
    # Rebinding can run a finalizer even for a literal RHS.
    module_defined: set[str] = set()
    seen: set[str] = set(_BUILTIN_NAMES)
    rebound: set[str] = set()
    for node in tree.body:
        plain, _imported = _bound_names(node)
        bound = _module_bindings(node)
        rebound.update(seen & bound)
        seen.update(bound)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            module_defined.add(node.name)
        else:
            module_defined.update(plain)

    statements: list[Statement] = []
    definitions: dict[str, list[int]] = {}
    preamble: list[int] = []
    preamble_bound: set[str] = set()
    for index, node in enumerate(tree.body):
        definition, defined = _classify(node, rebound)
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
            # Only a single-name literal assignment can be a definition.
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
    # v3 replaces optimistic purity inference with a closed definition grammar.
    # Old name lists can lack cross-module edges from import-time effects;
    # re-slicing cannot recover those dependencies, so rebuild once.
    digest = hashlib.sha256(b"slice3")
    for name in sorted(closed):
        digest.update(b"\0" + name.encode("utf-8") + (b"=" if name in syntax.definitions else b"!"))
    for statement in syntax.statements:
        if not statement.definition or any(name in closed for name in statement.binds):
            digest.update(b"\0\0" + statement.dump.encode("utf-8"))
    return "slice3:" + digest.hexdigest()
