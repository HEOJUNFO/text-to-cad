"""cadgen's mesher on what an ordinary part is not, and the STL cut from it.

A component of one vertex, a failure inside OCCT, a face OCCT's pass leaves
empty, the singular points of a cone or a sphere, a free edge or vertex beside a
solid, a mirrored placement inside a component: each once broke a mesh, the
export cut from it or the view drawing it. Shapes are built here; meshing needs
no store, except where a whole tree is meshed.
"""

from __future__ import annotations

import collections
import os
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

from tests.python.support.paths import add_repo_path

add_repo_path("packages/cadgen/src")
# The module, not its test class: imported, the class would run here as well.
from tests.python.packages.cadgen import test_mesh_export_manifold as exported  # noqa: E402
from tests.python.support.tmp_root import generated_cad_directory  # noqa: E402

CHORD, ANGLE = 1.5e-3, 0.35
IDENTITY = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]


def _surf_index(topods) -> dict:
    from cadgen._internal.surface_extract import extract_surface_component, read_surf

    return read_surf(extract_surface_component(topods))[0]


def _mesh(shape):
    """``shape`` meshed as the store meshes a component: its TESS body, decoded."""
    from cadgen._internal.mesh_formats import decode_tessellation
    from cadgen._internal.occt_mesh import mesh_component

    topods = getattr(shape, "wrapped", shape)
    body = mesh_component(topods, _surf_index(topods), surface_input="1" * 64, surface_object="a" * 64,
                          chord=CHORD, angle=ANGLE)
    return body, decode_tessellation(body)


def _compound(*shapes):
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Compound

    compound, builder = TopoDS_Compound(), BRep_Builder()
    builder.MakeCompound(compound)
    for shape in shapes:
        builder.Add(compound, getattr(shape, "wrapped", shape))
    return compound


def _corners(tessellation) -> np.ndarray:
    return tessellation.positions[tessellation.indices].reshape(-1, 3, 3).astype(np.float64)


def _collapsed(corners: np.ndarray) -> np.ndarray:
    """Triangles two of whose corners are one point."""
    a, b, c = corners[:, 0], corners[:, 1], corners[:, 2]
    return (a == b).all(axis=1) | (b == c).all(axis=1) | (c == a).all(axis=1)


def _open_edges(tessellation) -> int:
    """Edges one triangle uses once the mesh is welded by exact position, as a slicer welds it."""
    edges: collections.Counter = collections.Counter()
    corners = _corners(tessellation)
    for triangle in corners[~_collapsed(corners)]:
        points = [tuple(point) for point in triangle]
        for a, b in ((points[0], points[1]), (points[1], points[2]), (points[2], points[0])):
            edges[(a, b) if a < b else (b, a)] += 1
    return sum(1 for used in edges.values() if used == 1)


class DegenerateComponents(unittest.TestCase):
    def test_a_component_of_one_vertex_meshes_to_nothing(self):
        from build123d import Vertex

        _body, mesh = _mesh(_compound(Vertex(10, 0, 0)))
        self.assertEqual((len(mesh.positions), len(mesh.indices), mesh.face_ranges), (0, 0, []))

    def test_a_failure_inside_occt_is_the_components_mesh_error(self):
        from build123d import Box
        from OCP import BRepMesh
        from OCP.Standard import Standard_ConstructionError

        from cadgen._internal.occt_mesh import MeshProductionError

        # Not a Standard_Failure in every OCP wheel: OCCT's own all the same.
        failing = mock.patch.object(BRepMesh, "BRepMesh_IncrementalMesh",
                                    side_effect=Standard_ConstructionError("no mesh"))
        with failing, self.assertRaisesRegex(MeshProductionError, r"Standard_ConstructionError: no mesh"):
            _mesh(Box(4, 4, 4))
        # A failure that is not OCCT's is not dressed up as one.
        with mock.patch.object(BRepMesh, "BRepMesh_IncrementalMesh", side_effect=KeyError("bug")), \
                self.assertRaises(KeyError):
            _mesh(Box(4, 4, 4))

    def test_a_tree_with_a_lone_vertex_meshes_every_component(self):
        from build123d import Box, Compound, Cylinder, Pos, Vertex

        from cadgen.store import meshes, surfaces
        from cadgen.store.build import build_tree_from_compound

        with generated_cad_directory(prefix="occt-mesh-vertex-") as temporary, \
                mock.patch.dict(os.environ, {"CADGEN_CACHE_DIR": str(Path(temporary) / "cache")}):
            tree, geometry, _ = build_tree_from_compound(
                Compound(children=[Box(4, 4, 4), Vertex(10, 0, 0), Pos(20, 0, 0) * Cylinder(2, 4)]), root_name="trio")
            producer = surfaces.producer_identity()
            surfaces.derive(tree, producer=producer, tessellations=[{"chordTolerance": CHORD, "angleTolerance": ANGLE}])
            stored = [meshes.probe(meshes.tessellation_key(surfaces.lookup(entry, producer)["surfaceInput"], CHORD, ANGLE))
                      is not None for entry in geometry["components"].values()]
        self.assertEqual(stored, [True, True, True])


class StlAtSingularPoints(unittest.TestCase):
    def test_an_stl_of_poles_and_apexes_is_manifold_and_watertight(self):
        import trimesh
        from build123d import Box, Cone, Pos, Sphere, fillet

        from cadgen._internal.mesh_formats import build_primitives, stl_bytes

        parts = {
            "fully filleted box": fillet(Box(20, 20, 20).edges(), 3),
            "sphere beside a cone": _compound(Sphere(6), Pos(20, 0, 0) * Cone(5, 0, 10)),
        }
        descriptor = {"components": {"c": {}}, "occurrences": [{"id": "o1", "component": "c", "transform": IDENTITY}]}
        with generated_cad_directory(prefix="occt-mesh-stl-") as temporary:
            for label, shape in parts.items():
                with self.subTest(label):
                    _body, mesh = _mesh(shape)
                    # The case is still the case: OCCT's mesh, as stored, has them.
                    self.assertTrue(_collapsed(_corners(mesh)).any(), "the stored mesh has collapsed triangles")
                    path = Path(temporary) / f"{label}.stl"
                    path.write_bytes(stl_bytes(build_primitives(descriptor, {"c": mesh})))
                    exported.MeshExportManifoldTest.assertManifold(self, path, label)
                    self.assertTrue(trimesh.load(path).is_watertight)


class EmptyFace(unittest.TestCase):
    def test_a_face_the_pass_leaves_empty_is_meshed_with_its_whole_component_and_no_crack(self):
        from build123d import Box, Cylinder
        from OCP import BRepMesh
        from OCP.BRepTools import BRepTools
        from OCP.TopAbs import TopAbs_FACE
        from OCP.TopExp import TopExp
        from OCP.TopTools import TopTools_IndexedMapOfShape

        topods = (Box(20, 20, 10) - Cylinder(4, 10)).wrapped
        bore = next(row["ord"] for row in _surf_index(topods)["faces"] if row["surfaceType"] == "cylinder")
        faces = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(topods, TopAbs_FACE, faces)
        real, meshed = BRepMesh.BRepMesh_IncrementalMesh, []

        def mesher(shape, *args):
            result = real(shape, *args)
            meshed.append(shape)
            if len(meshed) == 1:  # the component's pass leaves the bore empty
                BRepTools.Clean_s(faces.FindKey(bore))
            return result

        with mock.patch.object(BRepMesh, "BRepMesh_IncrementalMesh", side_effect=mesher):
            _body, mesh = _mesh(topods)
        self.assertGreater(len(meshed), 1, "the component was meshed again")
        self.assertTrue(all(shape.IsSame(topods) for shape in meshed), "always the whole component")
        bore_range = next(row for row in mesh.face_ranges if row["ord"] == bore)
        self.assertGreater(bore_range["indexCount"], 0)
        self.assertEqual(_open_edges(mesh), 0, "the bore meets its neighbours along every edge")


class Normals(unittest.TestCase):
    def test_no_normal_points_into_the_solid_at_a_cones_apex(self):
        from build123d import Cone

        for label, cone in (("apex up", Cone(5, 0, 10)), ("apex down", Cone(0, 5, 10))):
            with self.subTest(label):
                _body, mesh = _mesh(cone)
                corners = _corners(mesh)
                facets = np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0])
                lengths = np.linalg.norm(facets, axis=1)
                covering = lengths > 0
                facets = facets[covering] / lengths[covering, None]
                normals = mesh.normals[mesh.indices.reshape(-1, 3)[covering]].astype(np.float64)
                self.assertGreater(float(np.einsum("tj,tkj->tk", facets, normals).min()), 0.0)

    def test_the_writers_reading_and_the_face_by_face_one_are_the_same_bytes(self):
        from build123d import Cone, Sphere

        from cadgen._internal import occt_mesh

        for label, shape in (("cone", lambda: Cone(5, 0, 10)), ("sphere", lambda: Sphere(6))):
            with self.subTest(label):
                written, _ = _mesh(shape())
                with mock.patch.object(occt_mesh, "_faces_from_gltf", return_value=None):
                    read, _ = _mesh(shape())
                self.assertEqual(written, read)


class LooseGeometry(unittest.TestCase):
    def test_a_free_edge_or_vertex_beside_a_solid_keeps_the_writers_path(self):
        from build123d import Box, Edge, Vertex

        from cadgen._internal import occt_mesh

        for label, loose in (("edge", Edge.make_line((10, 0, 0), (20, 0, 0))), ("vertex", Vertex(10, 0, 0))):
            with self.subTest(label), mock.patch.object(
                    occt_mesh, "_faces_one_by_one", wraps=occt_mesh._faces_one_by_one) as one_by_one:
                _body, mesh = _mesh(_compound(Box(5, 5, 5), loose))
                one_by_one.assert_not_called()
                self.assertEqual(len(mesh.indices) // 3, 12)

    def test_a_mirrored_placement_read_face_by_face_still_faces_outward(self):
        from build123d import Box
        from OCP.TopLoc import TopLoc_Location
        from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf

        from cadgen._internal import occt_mesh

        mirror = gp_Trsf()
        mirror.SetMirror(gp_Ax2(gp_Pnt(50, 0, 0), gp_Dir(1, 0, 0)))
        mirrored = Box(10, 10, 10).wrapped.Moved(TopLoc_Location(mirror), False)
        with mock.patch.object(occt_mesh, "_faces_from_gltf", return_value=None):
            _body, mesh = _mesh(_compound(mirrored))
        corners = _corners(mesh)
        volume = np.einsum("ij,ij->i", corners[:, 0], np.cross(corners[:, 1], corners[:, 2])).sum() / 6
        self.assertAlmostEqual(float(volume), 1000.0, places=3)


if __name__ == "__main__":
    unittest.main()
