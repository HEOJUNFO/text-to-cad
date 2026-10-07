"""``cadgen glb build --animation``: the request, and what it refuses.

A GLB is the one mesh format with somewhere to put a clip, so this is the GLB
door's half of choreography. The other half — the clip itself — is the keyframes
baked into the document sidecar's ``animation`` section, which the export samples
(``cadgen._internal.glb_animation``).

Two things live here and nowhere else. The first is the request's shape: a
closed key set (``clip``, ``fps``, ``seconds``, ``start``, ``drop``, ``deform``,
``deformTolerance``) whose values are checked before any meshing, because the
alternative is learning that ``fps: 0`` is nonsense after a tessellation.
The second is what the export's freshness key has to include beyond the
document's bytes: the
choreography is an annotation the STEP does not hash, so an edited animation
must invalidate a ledgered animated GLB (:func:`animation_variant_token`) or the
door would report an old clip current forever.

``--animation`` is deliberately NOT ``snapshot --video``, which shares three of
its key names. A video is pixels: it has a camera, a quality, and an fps that is
a PLAYBACK rate. A GLB carries the animation itself: no camera, no quality, and
fps is the SAMPLING rate of the keyframes baked into the file.

Stdlib only, like the mesh door it serves: nothing here may reach the CAD stack.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

# The request's closed vocabulary. No camera and no quality: this writes
# geometry, not pixels, and a key that means nothing is a key that misleads.
ANIMATION_REQUEST_KEYS = frozenset(
    {"clip", "fps", "seconds", "start", "drop", "deform", "deformTolerance"}
)

DEFAULT_ANIMATION_FPS = 30
MIN_ANIMATION_FPS = 1
# 120 samples per second is past any playback need and well past what a
# keyframed rigid motion carries.
MAX_ANIMATION_FPS = 120
# The ceiling that actually bounds the file, because the sample count is fps
# TIMES seconds: an fps bound alone still lets `{"fps": 30, "seconds": 3000}` --
# a caller writing milliseconds -- bake 90,000 keyframes PER MOVING OCCURRENCE,
# each a translation, a quaternion and a time. 7200 is four minutes at 30 fps.
# The sampler enforces the same ceiling (glb_animation.resolve_frame_plan),
# because it is where the clip-duration default for `seconds` is resolved.
MAX_ANIMATION_SAMPLES = 7200

# Effects glTF has no animated channel for, which `drop` may bake as static
# instead of having the export refuse them.
DROPPABLE_EFFECTS = ("opacity", "visible")

# What `deform` may say about a clip that deforms tube geometry. "refuse" stops
# the export and names the tubes; "rest" ships them at rest shape and warns;
# "morph" bakes the deformation as glTF morph targets and drives them from the
# clip's own schedule (cadgen._internal.tube_morph).
DEFORM_MODES = ("refuse", "morph", "rest")
DEFAULT_DEFORM_MODE = "refuse"

# How far a morph bake's blended tubes may sit from the clip's own deformation,
# in millimetres of the model's own units.
#
# It is a real tolerance, not a target count: morph weights blend the RESULT of
# two poses while the clip blends its inputs and rebuilds the path from them, so
# the two agree only at the baked instants and the targets have to be FITTED to a
# stated error. The default is about two thirds of a typical tendon's diameter.
# Below ~0.25mm the bytes buy precision the rest of the file does not carry: the
# rigid channels beside these tubes are sampled at `fps`, and fitting a cord to a
# tenth of a millimetre while the finger it runs through moves in 1/24s steps
# spends memory on nothing.
DEFAULT_MORPH_TOLERANCE_MM = 1.0
MIN_MORPH_TOLERANCE_MM = 0.01
MAX_MORPH_TOLERANCE_MM = 10.0


def normalize_animation_request(value: object, *, where: str) -> dict[str, object]:
    """The door's ``animation`` request, validated.

    Both spellings land here -- the flag's clip name or inline JSON, and a real
    dict from ``glb.build(animation={...})`` -- so one validator holds the
    shape. ``seconds`` stays ``None`` when the caller named none: the default is
    what is LEFT of the clip from ``start``, which only the sampler works out,
    holding the clip's duration and loop flag. The sample ceiling below can
    therefore only be applied here to a span the caller named; the sampler
    applies it to the one it resolves.
    """
    if not isinstance(value, dict):
        raise ValueError(
            f"{where} must be a clip name or a "
            f"{{{', '.join(sorted(ANIMATION_REQUEST_KEYS))}}} object"
        )
    unknown = sorted(set(value) - ANIMATION_REQUEST_KEYS)
    if unknown:
        raise ValueError(
            f"{where} has unknown key(s): {', '.join(unknown)}; "
            f"supported keys: {', '.join(sorted(ANIMATION_REQUEST_KEYS))}"
        )

    clip = value.get("clip")
    if not isinstance(clip, str) or not clip.strip():
        raise ValueError(f"{where} must name a clip the document sidecar's animation declares")

    raw_fps = value.get("fps", DEFAULT_ANIMATION_FPS)
    if isinstance(raw_fps, bool) or not isinstance(raw_fps, int):
        raise ValueError(
            f"{where} fps must be a whole number of samples per second "
            f"({MIN_ANIMATION_FPS}..{MAX_ANIMATION_FPS}), got {raw_fps!r}"
        )
    if not MIN_ANIMATION_FPS <= raw_fps <= MAX_ANIMATION_FPS:
        raise ValueError(
            f"{where} fps must be {MIN_ANIMATION_FPS}..{MAX_ANIMATION_FPS}, got {raw_fps}"
        )

    raw_seconds = value.get("seconds")
    seconds: float | None = None
    if raw_seconds is not None:
        seconds = _finite_number(raw_seconds, where=where, field="seconds")
        if seconds <= 0:
            raise ValueError(f"{where} seconds must be greater than 0, got {raw_seconds!r}")
        samples = math.floor(seconds * raw_fps + 0.5)  # the sampler's own rounding
        if samples > MAX_ANIMATION_SAMPLES:
            raise ValueError(
                f"{where} {seconds:g}s at {raw_fps} fps bakes {samples} samples, past the "
                f"{MAX_ANIMATION_SAMPLES}-sample ceiling (every sample is a keyframe per "
                "moving occurrence in the file)"
            )

    raw_start = value.get("start", 0)
    start = _finite_number(raw_start, where=where, field="start")
    if start < 0:
        raise ValueError(f"{where} start must be seconds >= 0, got {raw_start!r}")

    raw_drop = value.get("drop", [])
    if isinstance(raw_drop, str) or not isinstance(raw_drop, (list, tuple)):
        raise ValueError(
            f"{where} drop must be a list of effect names ({', '.join(DROPPABLE_EFFECTS)}), "
            f"got {raw_drop!r}"
        )
    drop = sorted({str(name).strip() for name in raw_drop})
    unknown_drop = [name for name in drop if name not in DROPPABLE_EFFECTS]
    if unknown_drop:
        raise ValueError(
            f"{where} drop names {', '.join(unknown_drop)}; only these effects can be baked "
            f"static: {', '.join(DROPPABLE_EFFECTS)}"
        )

    deform = str(value.get("deform", DEFAULT_DEFORM_MODE) or DEFAULT_DEFORM_MODE).strip().lower()
    if deform not in DEFORM_MODES:
        raise ValueError(
            f"{where} deform must be one of: {', '.join(DEFORM_MODES)}; got {value.get('deform')!r}"
        )

    request: dict[str, object] = {
        "clip": clip.strip(),
        "fps": raw_fps,
        "seconds": seconds,
        "start": start,
        "drop": drop,
        "deform": deform,
    }
    # Only meaningful under "morph", so it is REFUSED anywhere else rather than
    # accepted and ignored: a tolerance that silently did nothing would be read as
    # a promise about the file's accuracy that the file does not keep. Absent
    # otherwise, which also keeps every non-morph request's canonical form -- and
    # so its ledger key -- free of it.
    raw_tolerance = value.get("deformTolerance")
    if raw_tolerance is not None:
        if deform != "morph":
            raise ValueError(
                f"{where} deformTolerance is how close a MORPH bake's targets must stay to the "
                f"clip's own deformation, and this request's deform is {deform!r}; pass "
                'deform: "morph" to bake the tubes, or drop deformTolerance'
            )
        tolerance = _finite_number(raw_tolerance, where=where, field="deformTolerance", unit="millimetres")
        if not MIN_MORPH_TOLERANCE_MM <= tolerance <= MAX_MORPH_TOLERANCE_MM:
            raise ValueError(
                f"{where} deformTolerance must be {MIN_MORPH_TOLERANCE_MM}..."
                f"{MAX_MORPH_TOLERANCE_MM} mm, got {raw_tolerance!r}"
            )
        request["deformTolerance"] = tolerance
    elif deform == "morph":
        request["deformTolerance"] = DEFAULT_MORPH_TOLERANCE_MM

    return request


def _finite_number(value: object, *, where: str, field: str, unit: str = "seconds") -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{where} {field} must be a number of {unit}, got {value!r}")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{where} {field} must be a finite number of {unit}, got {value!r}")
    return number


def parse_animation_option(raw_animation: object, *, where: str = "--animation") -> dict[str, object]:
    """``--animation`` in request form.

    Already an object when it came from a ``glb.build(animation={...})`` call;
    from argv it is one string, told apart by shape the way ``--kinematics`` is:
    text that opens with ``{`` is the inline JSON request, anything else is the
    NAME of a clip the document sidecar's animation declares. There is no file-path
    spelling -- a clip request is a handful of keys, not a document.
    """
    if isinstance(raw_animation, dict):
        return normalize_animation_request(raw_animation, where=where)
    text = str(raw_animation or "").strip()
    if not text:
        raise ValueError(
            f"{where} requires a clip name or a JSON object: "
            f"{{{', '.join(sorted(ANIMATION_REQUEST_KEYS))}}}"
        )
    if text.startswith("{"):
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Failed to parse JSON from {where}: {exc}") from exc
        return normalize_animation_request(parsed, where=where)
    return normalize_animation_request({"clip": text}, where=where)


def animation_variant_token(request: dict[str, object], animation_data: str) -> str:
    """This animated export's identity, for the mesh-export ledger.

    A static mesh is a pure function of the document's bytes and its tolerances,
    which is what the ledger keys on. An ANIMATED one is also a function of the
    request and the sidecar's keyframes. Folding both into the variant key makes
    a rebaked animation re-export motion without rebuilding geometry.
    """
    import hashlib

    canonical = json.dumps(request, sort_keys=True, separators=(",", ":"))
    # Admit only exports produced from the same captured keyframes as their token.
    digest = hashlib.sha256(b"cadgen-animation-keyframes-v1\0")
    digest.update(canonical.encode("utf-8"))
    digest.update(b"\0")
    digest.update(str(animation_data).encode("utf-8"))
    return digest.hexdigest()[:32]


@dataclass(frozen=True)
class AnimationSnapshot:
    """The sidecar's ``animation`` section as read once, canonical JSON text."""

    data: str
    document_hash: str
    appearance: dict | None


def resolve_animation(document: Path, request: dict[str, object]) -> tuple[AnimationSnapshot, str]:
    """``(animation snapshot, variant token)`` for an animated export.

    The clip NAME is checked HERE -- a typo must fail as a clean CLI error naming
    the clips the model has, before anything is meshed. Both the token and the
    sampler consume this same snapshot, even if the sidecar is rewritten during
    meshing.
    """
    from cadgen._internal.source_sidecar import read_source_sidecar
    from cadgen.catalog import artifact_file_hash

    document_hash = artifact_file_hash(document)
    if not document_hash:
        raise ValueError(f"Could not read STEP document: {document}")
    sidecar = read_source_sidecar(document, document_hash=document_hash) or {}
    animation = sidecar.get("animation")
    if animation is None:
        raise ValueError(f"{Path(document).name} has no animation in its sidecar. Declare animation= on @step.")
    clip_name = str(request["clip"])
    declared = [clip["id"] for clip in animation["clips"]]
    if clip_name not in declared:
        raise ValueError(f"Unknown animation clip: {clip_name}. This model declares: {', '.join(declared)}")
    data = json.dumps(animation, sort_keys=True, separators=(",", ":"))
    return AnimationSnapshot(data, document_hash, sidecar.get("appearance")), animation_variant_token(request, data)
