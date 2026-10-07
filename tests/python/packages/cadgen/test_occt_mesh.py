"""cadgen's mesher keeps a component whole when OCCT's pass leaves a face empty.

OCCT's mesher drops the odd tiny face at one deflection and meshes it at the
next (a watch case's 0.002 mm² slivers did, and with them every component the
same request covered). Here the component's pass is made to leave one face of a
bored block empty, as that one did, and the mesher must mesh it alone, leave
every other face as the pass made it, and fail only for a face it cannot mesh
that is larger than the mesh can resolve.
"""

import json
import os
import struct
import unittest
from pathlib import Path
from unittest import mock

from tests.python.support.paths import add_repo_path

add_repo_path("packages/cadgen/src")
from tests.python.support.tmp_root import generated_cad_directory  # noqa: E402

CHORD, ANGLE = 1.5e-3, 0.35


def _component():
    from build123d import Box, Cylinder

    from cadgen._internal.component_package import decode_display_shape, prepare_geometry_component
    from cadgen._internal.surface_extract import extract_surface_component, read_surf

    prepared = prepare_geometry_component(Box(20, 20, 10) - Cylinder(4, 10))
    entry, payload = prepared["entry"], prepared["payload"]
    index, _ = read_surf(extract_surface_component(decode_display_shape(entry, payload).wrapped))
    return (lambda: decode_display_shape(entry, payload).wrapped), index


def _faces(body: bytes) -> dict[int, int]:
    """Each face's triangle count, from a TESS body (every face has a range; an empty one counts 0)."""
    header = json.loads(body[12:12 + struct.unpack_from("<I", body, 8)[0]])
    return {row["ord"]: row["indexCount"] // 3 for row in header["faceRanges"]}


class EmptyFaces(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fresh, cls.index = _component()
        cls.fresh = staticmethod(fresh)

    def mesh(self, emptied: int | None, *, every_pass: bool = False, index=None) -> bytes:
        """Mesh the component with face ``emptied`` left without triangles by the
        component's pass (and, with ``every_pass``, by every retry too)."""
        from OCP import BRepMesh
        from OCP.BRepTools import BRepTools
        from OCP.TopAbs import TopAbs_FACE
        from OCP.TopExp import TopExp
        from OCP.TopTools import TopTools_IndexedMapOfShape

        from cadgen._internal.occt_mesh import mesh_component

        real = BRepMesh.BRepMesh_IncrementalMesh
        topods = self.fresh()
        faces = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(topods, TopAbs_FACE, faces)
        calls = []

        def mesher(shape, *args):
            result = real(shape, *args)
            calls.append(shape)
            if emptied is not None and (every_pass or len(calls) == 1):
                BRepTools.Clean_s(faces.FindKey(emptied))
            return result

        with mock.patch.object(BRepMesh, "BRepMesh_IncrementalMesh", side_effect=mesher):
            body = mesh_component(topods, index or self.index, surface_input="1" * 64,
                                  surface_object="a" * 64, chord=CHORD, angle=ANGLE)
        self.calls = len(calls)
        return body

    def test_a_face_the_pass_leaves_empty_is_meshed_alone_and_the_rest_is_untouched(self):
        whole = _faces(self.mesh(None))
        self.assertEqual(sorted(whole), [row["ord"] for row in self.index["faces"]])
        face = max(whole, key=whole.get)
        repaired = _faces(self.mesh(face))
        self.assertGreater(self.calls, 1, "the empty face was meshed again")
        self.assertGreater(repaired[face], 0)
        self.assertEqual({o: n for o, n in repaired.items() if o != face},
                         {o: n for o, n in whole.items() if o != face}, "every other face is as the pass made it")

    def test_a_face_no_pass_meshes_is_left_out_only_below_what_the_mesh_resolves(self):
        from cadgen._internal.occt_mesh import MeshProductionError, _bounding_diagonal

        face = self.index["faces"][0]["ord"]
        deflection = CHORD * _bounding_diagonal(self.fresh())
        sliver = {**self.index, "faces": [{**row, "area": deflection * deflection / 4} if row["ord"] == face else row
                                          for row in self.index["faces"]]}
        self.assertEqual(_faces(self.mesh(face, every_pass=True, index=sliver))[face], 0, "drawn with no triangles")
        with self.assertRaisesRegex(MeshProductionError, rf"did not mesh 1 face\(s\) of the component: f{face}\b"):
            self.mesh(face, every_pass=True)


class ARequestOutlivesOneComponent(unittest.TestCase):
    def test_a_component_that_fails_to_mesh_leaves_the_rest_of_its_request_meshed(self):
        from build123d import Box, Compound, Cylinder, Pos

        from cadgen._internal import occt_mesh
        from cadgen.store import meshes, surfaces
        from cadgen.store.build import build_tree_from_compound

        with generated_cad_directory(prefix="occt-mesh-request-") as temporary, \
                mock.patch.dict(os.environ, {"CADGEN_CACHE_DIR": str(Path(temporary) / "cache")}):
            tree, geometry, _ = build_tree_from_compound(
                Compound(children=[Box(4, 4, 4), Pos(10, 0, 0) * Cylinder(2, 4)]), root_name="pair")
            real, failed = occt_mesh.mesh_component, []

            def mesher(topods, index, *, surface_input, **options):
                if not failed:
                    failed.append(surface_input)
                    raise occt_mesh.MeshProductionError("OCCT did not mesh 1 face(s) of the component: f1")
                return real(topods, index, surface_input=surface_input, **options)

            producer = surfaces.producer_identity()
            with mock.patch.object(occt_mesh, "mesh_component", side_effect=mesher), \
                    self.assertRaisesRegex(occt_mesh.MeshProductionError, r"^component [0-9a-f]{16}: OCCT did not mesh"):
                surfaces.derive(tree, producer=producer,
                                tessellations=[{"chordTolerance": CHORD, "angleTolerance": ANGLE}])
            inputs = [surfaces.lookup(entry, producer)["surfaceInput"] for entry in geometry["components"].values()]
            stored = {surface_input: meshes.probe(meshes.tessellation_key(surface_input, CHORD, ANGLE)) is not None
                      for surface_input in inputs}
            self.assertEqual(stored, {surface_input: surface_input != failed[0] for surface_input in inputs},
                             "the other component was meshed and stored before the failure was reported")


if __name__ == "__main__":
    unittest.main()
