import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as THREE from 'three';
import {TUBE_GPU_STAGE, tubeMaterialStage} from './tubeMaterialShader.js';
import {compileTubePath,sampleTubePath,normalizeTubeDeformation,applyRecordTubeDeformation} from './tubeDeformation.js';

const gpuTubeMaterialStage=(material)=>tubeMaterialStage(material,TUBE_GPU_STAGE);
const REST_LINE={normal:[0,0,1],segments:[{kind:'line',start:[0,0,0],end:[10,0,0]}]};

/** A posed GPU record, so the frame table is read where the shader reads it. */
function gpuTubeRecord(path){
  const source=new THREE.CylinderGeometry(.3,.3,10,16,10,false);source.rotateZ(-Math.PI/2);source.translate(5,0,0);
  const mesh=new THREE.Mesh(source,new THREE.MeshStandardMaterial());mesh.updateMatrixWorld();
  const record={mesh,geometry:source,gpuTubeDeformationAllowed:true,partBounds:{min:[0,-.3,-.3],max:[10,.3,.3]}};
  applyRecordTubeDeformation(THREE,record,normalizeTubeDeformation({rest:REST_LINE,path}));
  assert.ok(record.tubeGpuState?.active,'the GPU display path must be the one under test');
  return record;
}

test('GPU frame positions stay within one micron of analytic paths at display samples',()=>{
  const paths=[
    {normal:[0,0,1],segments:[{kind:'line',start:[0,0,0],end:[40,0,0]}]},
    {normal:[0,0,1],segments:[{kind:'arc',center:[0,3.5,0],axis:[0,0,1],start:[0,0,0],sweepDeg:280}]},
    {normal:[0,0,1],segments:[{kind:'bezier',points:[[0,0,0],[20,0,0],[5,25,8],[30,30,20]]}]}
  ];
  for(const raw of paths){
    const path=compileTubePath(raw),{data,count}=gpuTubeRecord(raw).tubeGpuState.frames;
    for(let i=0;i<=2000;i++){
      const f=i/2000*(count-1),lo=Math.floor(f),hi=Math.min(lo+1,count-1),u=f-lo;
      const expected=sampleTubePath(path,path.length*i/2000);
      const actual=[0,1,2].map(k=>data[lo*16+k]*(1-u)+data[hi*16+k]*u);
      assert.ok(Math.hypot(...actual.map((v,k)=>v-expected.point[k]))<.001);
      const tangent=[0,1,2].map(k=>data[lo*16+4+k]*(1-u)+data[hi*16+4+k]*u);
      assert.ok(Math.hypot(...tangent.map((v,k)=>v-expected.tangent[k]))<.001);
    }
  }
});

test('GPU display preserves source buffers, materializes exact picking, and updates late highlight materials',()=>{
  const source=new THREE.CylinderGeometry(.3,.3,10,16,10,false);source.rotateZ(-Math.PI/2);source.translate(5,0,0);
  const mesh=new THREE.Mesh(source,new THREE.MeshStandardMaterial());mesh.updateMatrixWorld();
  const record={mesh,geometry:source,gpuTubeDeformationAllowed:true,partBounds:{min:[0,-.3,-.3],max:[10,.3,.3]}};
  const rest={normal:[0,0,1],segments:[{kind:'line',start:[0,0,0],end:[10,0,0]}]};
  const path={normal:[0,0,1],segments:[{kind:'arc',center:[0,5,0],axis:[0,0,1],start:[0,0,0],sweepDeg:90}]};
  const spec=normalizeTubeDeformation({rest,path}),saved=source.attributes.position.array.slice();
  applyRecordTubeDeformation(THREE,record,spec);
  assert.ok(record.tubeGpuState.active);assert.ok(gpuTubeMaterialStage(mesh.customDepthMaterial));
  assert.ok(record.tubeDeformationState.mapping.values instanceof Float32Array);
  assert.equal(record.tubeGpuState.mappingTexture.image.data,record.tubeDeformationState.mapping.values);
  assert.equal(record.geometry.attributes.cadTubeMappingIndex.array,record.tubeDeformationState.mapping.indices);
  assert.equal(record.geometry.attributes.cadTubeMaterial,undefined);
  const away=new THREE.Raycaster(new THREE.Vector3(100,100,100),new THREE.Vector3(0,0,-1));
  assert.equal(mesh.userData.cadBeforeRaycast(away),false);assert.equal(record.tubeGpuState.cpuSpec,null);
  const near=new THREE.Raycaster(new THREE.Vector3(3.535,1.465,10),new THREE.Vector3(0,0,-1));
  assert.equal(mesh.userData.cadBeforeRaycast(near),true);assert.equal(record.tubeGpuState.cpuSpec,spec.pathSpec);
  const cpu={mesh:new THREE.Mesh(source),geometry:source};applyRecordTubeDeformation(THREE,cpu,spec);
  assert.deepEqual(record.geometry.attributes.position.array,cpu.geometry.attributes.position.array);
  assert.deepEqual(source.attributes.position.array,saved);
  record.ghostMesh=new THREE.Mesh(record.geometry,new THREE.MeshBasicMaterial());applyRecordTubeDeformation(THREE,record,spec);
  assert.equal(gpuTubeMaterialStage(record.ghostMesh.material).uniforms,record.tubeGpuState.uniforms);
  const shader={uniforms:{},vertexShader:'#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>',fragmentShader:'#include <common>'};
  mesh.material.onBeforeCompile(shader);assert.ok(shader.vertexShader.includes('transformed = cadGpuPoint'));assert.ok(shader.uniforms.cadTubeFrameTexture.value);
  applyRecordTubeDeformation(THREE,record,null);assert.equal(record.tubeGpuState.uniforms.cadTubeGpuEnabled.value,0);assert.equal(mesh.userData.cadBeforeRaycast,null);
});

test('braid enabled after a GPU deformation reads the mapping-derived coordinates the CPU path stores',()=>{
  const source=new THREE.CylinderGeometry(.3,.3,10,16,10,false);source.rotateZ(-Math.PI/2);source.translate(5,0,0);
  const material=new THREE.MeshStandardMaterial();
  const gpu={mesh:new THREE.Mesh(source,material),geometry:source,gpuTubeDeformationAllowed:true,partBounds:{min:[0,-.3,-.3],max:[10,.3,.3]}};
  const rest={normal:[0,0,1],segments:[{kind:'line',start:[0,0,0],end:[10,0,0]}]};
  const path={normal:[0,0,1],segments:[{kind:'arc',center:[0,5,0],axis:[0,0,1],start:[0,0,0],sweepDeg:90}]};
  applyRecordTubeDeformation(THREE,gpu,normalizeTubeDeformation({rest,path}));
  assert.equal(tubeMaterialStage(material,'braid'),null);
  // A later frame turns the finish on while the GPU transport is already installed.
  applyRecordTubeDeformation(THREE,gpu,normalizeTubeDeformation({rest,path,braid:{pitch:.8,depth:.02,strands:8}}));
  const shader={uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};
  material.onBeforeCompile(shader,{});
  assert.ok(shader.vertexShader.includes('vCadTubeMaterial = cadTubeMaterialCoordinates();'),'GPU stage feeds the shared varying');
  assert.ok(!shader.vertexShader.includes('vCadTubeMaterial = cadTubeMaterial;'),'braid does not read the absent CPU attribute');
  assert.ok(shader.vertexShader.indexOf('cadTubeMaterialCoordinates') < shader.fragmentShader.length);
  assert.ok(shader.fragmentShader.includes('cadBraidNormal(-vViewPosition'));
  assert.equal(shader.uniforms.cadBraidEnabled.value,1);
  assert.equal(gpu.geometry.attributes.cadTubeMaterial,undefined);
  // The GPU shader derives (s, u, v) from its mapping texture; that must equal
  // the attribute the CPU path would have written for the same vertices.
  const cpu={mesh:new THREE.Mesh(source,new THREE.MeshStandardMaterial()),geometry:source,partBounds:gpu.partBounds};
  applyRecordTubeDeformation(THREE,cpu,normalizeTubeDeformation({rest,path,braid:{pitch:.8,depth:.02,strands:8}}));
  const expected=cpu.geometry.attributes.cadTubeMaterial,mapping=gpu.tubeDeformationState.mapping,restLength=10;
  assert.equal(mapping.values,gpu.tubeGpuState.mappingTexture.image.data);
  let nonZero=0;
  for(let i=0;i<expected.count;i++){
    const j=mapping.indices[i]*8;
    const derived=[mapping.values[j]*restLength,mapping.values[j+1],mapping.values[j+2]];
    const stored=[expected.getX(i),expected.getY(i),expected.getZ(i)];
    for(let k=0;k<3;k++)assert.ok(Math.abs(derived[k]-stored[k])<1e-5,`vertex ${i}: ${derived} != ${stored}`);
    if(Math.hypot(...derived)>1e-6)nonZero++;
  }
  assert.ok(nonZero>expected.count*.9);
  // Braid can be enabled first and the GPU transport second with the same result.
  const reversed=new THREE.MeshStandardMaterial(),other={mesh:new THREE.Mesh(source,reversed),geometry:source,gpuTubeDeformationAllowed:true,partBounds:gpu.partBounds};
  applyRecordTubeDeformation(THREE,other,normalizeTubeDeformation({rest,path,braid:{pitch:.8,depth:.02,strands:8}}));
  const again={uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};
  reversed.onBeforeCompile(again,{});
  assert.equal(again.vertexShader,shader.vertexShader);
  assert.equal(reversed.customProgramCacheKey(),material.customProgramCacheKey());
});

// A coil spring's centerline `height` tall: quarter-turn Beziers rising evenly along +z.
// Compressed, it is its rest under one affine map, as a tube key's map names it.
function coilSpec(height,turns=3,r=4){
  const k=4/3*Math.tan(Math.PI/8),n=4*turns,rise=height/n,segments=[];
  for(let j=0;j<n;j++){
    const a=j*Math.PI/2,b=a+Math.PI/2,z=j*rise;
    segments.push({kind:'bezier',points:[[r*Math.cos(a),r*Math.sin(a),z],[r*(Math.cos(a)-k*Math.sin(a)),r*(Math.sin(a)+k*Math.cos(a)),z+rise/3],[r*(Math.cos(b)+k*Math.sin(b)),r*(Math.sin(b)-k*Math.cos(b)),z+2*rise/3],[r*Math.cos(b),r*Math.sin(b),z+rise]]});
  }
  return {normal:[0,0,1],segments};
}

/** A spring as the scene holds one: a wire swept along `rest`, with a seam edge line. */
function coilRecord(rest){
  const path=compileTubePath(rest),rings=241,ring=12,positions=[],normals=[],index=[],seam=[];
  for(let i=0;i<rings;i++){
    const f=sampleTubePath(path,path.length*i/(rings-1));
    for(let k=0;k<ring;k++){
      const a=2*Math.PI*k/ring,n=[0,1,2].map(j=>Math.cos(a)*f.normal[j]+Math.sin(a)*f.binormal[j]);
      positions.push(...n.map((c,j)=>f.point[j]+.5*c));normals.push(...n);
    }
    seam.push(...f.normal.map((c,j)=>f.point[j]+.5*c));
  }
  for(let i=0;i+1<rings;i++) for(let k=0;k<ring;k++){const a=i*ring+k,b=i*ring+(k+1)%ring;index.push(a,a+ring,b,b,a+ring,b+ring);}
  const source=new THREE.BufferGeometry();
  source.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  source.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));source.setIndex(index);
  const lines=[];for(let i=0;i+1<seam.length/3;i++) lines.push(...seam.slice(3*i,3*i+6));
  const edges=new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(lines,3)));
  const mesh=new THREE.Mesh(source,new THREE.MeshStandardMaterial());mesh.updateMatrixWorld();
  return {mesh,geometry:source,edges,gpuTubeDeformationAllowed:true,partBounds:{min:[-5,-5,-1],max:[5,5,11]}};
}

test('a coil between two keys that map its rest is drawn from the keys\' tables, within a micron of its own path',()=>{
  // Two keys as close as a bake writes a spring's: the blended frames part from the
  // exact ones as the square of the keys' spacing (4% here, half a micron at the seam).
  const rest=coilSpec(10);
  const lerp=(a,b,u)=>({normal:[0,0,1],segments:a.segments.map((s,i)=>({kind:'bezier',points:s.points.map((p,j)=>p.map((c,k)=>c+(b.segments[i].points[j][k]-c)*u))}))});
  const key=(height)=>normalizeTubeDeformation({rest,path:coilSpec(height),mapsRest:true});
  const from=key(9),to=key(8.6);
  const between=(u)=>normalizeTubeDeformation({rest,path:lerp(coilSpec(9),coilSpec(8.6),u),between:{from,to,u}});
  const record=coilRecord(rest);
  for(const u of [.3,.7]){
    const deformation=between(u);
    applyRecordTubeDeformation(THREE,record,deformation);
    assert.ok(record.tubeGpuState?.active);
    // Built once each, for this pair, and lerped: nothing compiles the frame's own path.
    assert.deepEqual([...record.tubeDeformationState.keyFrames.keys()],[from,to]);
    const path=compileTubePath(deformation.pathSpec),{data,count}=record.tubeGpuState.frames;
    for(let i=0;i<=2000;i++){
      const f=i/2000*(count-1),lo=Math.floor(f),hi=Math.min(lo+1,count-1),w=f-lo;
      const expected=sampleTubePath(path,path.length*i/2000);
      const actual=[0,1,2].map(k=>data[lo*16+k]*(1-w)+data[hi*16+k]*w);
      assert.ok(Math.hypot(...actual.map((v,k)=>v-expected.point[k]))<.001,`u=${u} at ${i}/2000`);
    }
  }
  // Posed once, the seam lerps its keys' seams too, and lands where posing that same
  // path exactly on the CPU puts it.
  const exact=coilRecord(rest);exact.gpuTubeDeformationAllowed=false;
  applyRecordTubeDeformation(THREE,exact,normalizeTubeDeformation({rest,path:lerp(coilSpec(9),coilSpec(8.6),.7)}));
  const drawn=record.edges.geometry.attributes.position.array,want=exact.edges.geometry.attributes.position.array;
  assert.equal(drawn.length,want.length);
  for(let i=0;i<drawn.length;i++) assert.ok(Math.abs(drawn[i]-want[i])<.001,`seam coordinate ${i}`);
});
