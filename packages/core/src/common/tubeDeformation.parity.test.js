// cadgen bakes a clip's tube deformation into a GLB's morph targets in Python
// (cadgen/_internal/tube_deformation.py), and every pose it bakes has to be the one
// this runtime draws. tubeDeformation.parity.json holds rest meshes, rest paths and
// poses -- a bend, a twist, an S, a spring's mapped keys and the blend between two of
// them, a pinch -- with what the headless half (prepareTubeBake, poseTubeBake,
// sampleTubePath) makes of them: the refined mesh, its mapping onto the rest
// centerline, frames along every path, and every posed vertex. This test pins the
// JavaScript half and cadgen's test_tube_deformation.py the Python half against the
// same file.
//
// An intended change to the runtime rewrites the expected values (the inputs stay):
//
//   TUBE_PARITY_REWRITE=1 node --test packages/core/src/common/tubeDeformation.parity.test.js

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import * as THREE from "three";

import {
  compileDeformation,
  normalizeTubeDeformation,
  poseTubeBake,
  prepareTubeBake,
  sampleTubePath,
} from "./tubeDeformation.js";

const FIXTURE = new URL("./tubeDeformation.parity.json", import.meta.url);
const parity = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const IDENTITY = new THREE.Matrix4();

// Eight digits of the float32 data and twelve of the float64 results: finer than
// cadgen's half is held to (a hundredth of a micron in a position, 1e-9 elsewhere).
const f32 = (values) => Array.from(values, (value) => Number(Math.fround(value).toPrecision(8)));
const f64 = (values) => Array.from(values, (value) => Number(value.toPrecision(12)));

function caseDeformations(tubeCase) {
  const normalized = [];
  for (const pose of tubeCase.poses) {
    normalized.push(normalizeTubeDeformation({
      rest: tubeCase.rest,
      path: pose.path,
      twistDeg: pose.twistDeg,
      maxSegmentLength: tubeCase.maxSegmentLength,
      ...(pose.mapsRest ? { mapsRest: true } : {}),
      ...(pose.between ? {
        between: { from: normalized[pose.between.from], to: normalized[pose.between.to], u: pose.between.u },
      } : {}),
    }));
  }
  return normalized;
}

function probeFrames(path) {
  const distances = [-1, 0, 0.137 * path.length, 0.5 * path.length, 0.77 * path.length, path.length, path.length + 1.5];
  return distances.flatMap((distance) => {
    const frame = sampleTubePath(path, distance);
    return f64([...frame.point, ...frame.tangent, ...frame.normal, ...frame.binormal, ...frame.curvature]);
  });
}

function bake(tubeCase) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(tubeCase.mesh.positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(tubeCase.mesh.normals, 3));
  geometry.setIndex(tubeCase.mesh.indices);
  const deformations = caseDeformations(tubeCase);
  const compiled = deformations.map((deformation) => compileDeformation(deformation));
  const prepared = prepareTubeBake(THREE, geometry, compiled[0], IDENTITY);
  const refined = prepared.geometry;
  const positions = new THREE.Float32BufferAttribute(new Float32Array(prepared.vertexCount * 3), 3);
  const normals = new THREE.Float32BufferAttribute(new Float32Array(prepared.vertexCount * 3), 3);
  return {
    refined: {
      positions: f32(refined.attributes.position.array),
      normals: f32(refined.attributes.normal.array),
      indices: Array.from(refined.index.array),
      sourceTriangles: prepared.sourceTriangles ? Array.from(prepared.sourceTriangles) : null,
    },
    mapping: { values: f64(prepared.mapping.values), slots: Array.from(prepared.mapping.indices) },
    frames: [probeFrames(compiled[0].rest), ...compiled.map((deformation) => probeFrames(deformation.path))],
    poses: compiled.map((deformation) => {
      poseTubeBake(THREE, prepared, deformation, IDENTITY, positions, normals);
      return { positions: f32(positions.array), normals: f32(normals.array) };
    }),
  };
}

function assertClose(got, want, tolerance, where) {
  assert.equal(got.length, want.length, `${where}: ${got.length} values, expected ${want.length}`);
  for (let index = 0; index < want.length; index += 1) {
    if (!(Math.abs(got[index] - want[index]) <= tolerance)) {
      assert.fail(`${where}[${index}]: ${got[index]} != ${want[index]}`);
    }
  }
}

if (process.env.TUBE_PARITY_REWRITE) {
  for (const tubeCase of parity.cases) {
    tubeCase.expected = bake(tubeCase);
  }
  fs.writeFileSync(FIXTURE, `${JSON.stringify(parity)}\n`);
}

test("the headless tube runtime refines, maps, samples and poses what cadgen's bake ports", () => {
  for (const tubeCase of parity.cases) {
    const got = bake(tubeCase);
    const want = tubeCase.expected;
    const where = tubeCase.name;
    // The topology is exact: one band boundary misplaced is a different mesh.
    assert.deepEqual(got.refined.indices, want.refined.indices, `${where}: refined indices`);
    assert.deepEqual(got.refined.sourceTriangles, want.refined.sourceTriangles, `${where}: source triangles`);
    assert.deepEqual(got.mapping.slots, want.mapping.slots, `${where}: mapping slots`);
    assertClose(got.refined.positions, want.refined.positions, 0, `${where}: refined positions`);
    assertClose(got.refined.normals, want.refined.normals, 0, `${where}: refined normals`);
    assertClose(got.mapping.values, want.mapping.values, 0, `${where}: mapping`);
    want.frames.forEach((frames, index) => assertClose(got.frames[index], frames, 0, `${where}: frames ${index}`));
    want.poses.forEach((pose, index) => {
      assertClose(got.poses[index].positions, pose.positions, 0, `${where}: pose ${index} positions`);
      assertClose(got.poses[index].normals, pose.normals, 0, `${where}: pose ${index} normals`);
    });
  }
});
