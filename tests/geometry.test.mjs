import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { toPdf, strokePath, segmentDistance, hitsStroke, History, validateInk } from '../src/ink.js';
import { exportPdf, toBase64, fromBase64 } from '../src/pdf.js';

// Load the app's shipped PDF engine in this realm; export tests inspect actual PDFs.
const lib = {};
globalThis.__inkTestPdfLib = lib;
vm.runInThisContext(`(function(exports,module){${readFileSync(new URL('../vendor/pdf-lib.min.js', import.meta.url),'utf8')}\n})(globalThis.__inkTestPdfLib,{});`);
delete globalThis.__inkTestPdfLib;
globalThis.window = { PDFLib: lib };

const close = (actual, expected) => assert.ok(Math.abs(actual-expected)<1e-8, `${actual} != ${expected}`);
const page = { width: 200, height: 100 };
const validStroke = () => ({color:'#123456',width:2,points:[{x:10,y:15},{x:20,y:25}]});
// CropBox [40,30,240,130]. These displayed locations all name PDF (60,50).
const viewports = [
  {rotation:0, transform:[1,0,0,-1,-40,130], p:{x:20,y:80}, q:{x:40,y:60}},
  {rotation:90, transform:[0,1,1,0,-30,-40], p:{x:20,y:20}, q:{x:40,y:40}},
  {rotation:180, transform:[-1,0,0,1,240,-30], p:{x:180,y:20}, q:{x:160,y:40}},
  {rotation:270, transform:[0,-1,-1,0,130,240], p:{x:80,y:180}, q:{x:60,y:160}},
];

for (const v of viewports) {
  test(`viewport ${v.rotation}° with nonzero CropBox maps to the same PDF coordinates`, () => {
    assert.deepEqual(toPdf(v.p,v.transform),{x:60,y:50});
    assert.deepEqual(toPdf(v.q,v.transform),{x:80,y:70});
    const doubled=v.transform.map(n=>n*2);
    assert.deepEqual(toPdf({x:v.p.x*2,y:v.p.y*2},doubled),{x:60,y:50});
  });
}

test('invalid singular viewport is rejected', () => {
  assert.throws(()=>toPdf({x:1,y:2},[1,2,2,4,0,0]),/无效页面坐标/);
  assert.throws(()=>toPdf({x:1,y:2},[NaN,0,0,1,0,0]),/无效页面坐标/);
});

test('stroke path handles empty, dot and smooth multi-point stroke', () => {
  assert.equal(strokePath([]),'');
  assert.equal(strokePath([{x:2,y:3}]),'M 2 3');
  const points=[{x:0,y:0},{x:10,y:10},{x:20,y:0}];
  assert.equal(strokePath(points),'M 0 0 Q 10 10 15 5 L 20 0');
  // A quarter-turn and translation must transform controls and endpoints together.
  assert.equal(strokePath(points,p=>({x:100-p.y,y:p.x+30})),
    'M 100 30 Q 90 40 95 45 L 100 50');
});

test('eraser hits a long stroke midpoint and respects width and endpoints', () => {
  const stroke={width:4,points:[{x:10,y:10},{x:110,y:10}]};
  assert.equal(hitsStroke({x:60,y:13},stroke,1),true);
  assert.equal(hitsStroke({x:60,y:13.01},stroke,1),false);
  assert.equal(hitsStroke({x:7,y:10},stroke,1),true);
  assert.equal(hitsStroke({x:6.9,y:10},stroke,1),false);
  close(segmentDistance({x:60,y:14},stroke.points[0],stroke.points[1]),4);
});

test('eraser handles a dot and repeated samples without division by zero', () => {
  const dot={width:6,points:[{x:30,y:40}]};
  assert.equal(hitsStroke({x:34,y:40},dot,1),true);
  assert.equal(hitsStroke({x:34.1,y:40},dot,1),false);
  assert.equal(hitsStroke({x:30,y:40},{...dot,points:[...dot.points,...dot.points]},0),true);
});

test('eraser follows the visible smoothed curve rather than its control polygon', () => {
  const stroke={width:2,points:[{x:0,y:0},{x:100,y:100},{x:200,y:0}]};
  // The displayed first quadratic is Q(100,100) -> (150,50).
  // At t=1/2 its exact point is (87.5,62.5), far from the raw polygon.
  assert.equal(hitsStroke({x:87.5,y:62.5},stroke,2),true);
  assert.equal(hitsStroke({x:90,y:90},stroke,2),false);
});

test('history undoes across pages, redoes, and discards an abandoned branch', () => {
  const h=new History();
  const first={page:0,before:[],after:['a']};
  const second={page:2,before:[],after:['b']};
  h.push(first.page,first.before,first.after);h.push(second.page,second.before,second.after);
  assert.deepEqual(h.undo(),second);assert.deepEqual(h.undo(),first);
  assert.equal(h.undo(),undefined);
  assert.deepEqual(h.redo(),first);assert.deepEqual(h.redo(),second);
  assert.equal(h.redo(),undefined);
  h.undo();h.push(1,[],['c']);
  assert.equal(h.redo(),undefined);
  assert.deepEqual(h.undo(),{page:1,before:[],after:['c']});
  assert.deepEqual(h.undo(),first);
});

test('bounded history drops only the oldest operation', () => {
  const h=new History(2);h.push(0,[],['a']);h.push(1,[],['b']);h.push(2,[],['c']);
  assert.equal(h.undo().page,2);assert.equal(h.undo().page,1);assert.equal(h.undo(),undefined);
});

test('draft validation keeps independent data and valid edge coordinates', () => {
  const input=[[{...validStroke(),points:[{x:0,y:0},{x:200,y:100}],ignored:'extra'}]];
  const output=validateInk(input,[page]);
  assert.deepEqual(output,[[{color:'#123456',width:2,points:[{x:0,y:0},{x:200,y:100}]}]]);
  input[0][0].points[0].x=999;
  assert.equal(output[0][0].points[0].x,0);
});

test('draft validation rejects wrong pages and malformed or out-of-page strokes', () => {
  assert.throws(()=>validateInk([], [page]),/页数/);
  assert.throws(()=>validateInk([{}], [page]),/格式/);
  for(const bad of [
    {...validStroke(),color:'red'}, {...validStroke(),width:0}, {...validStroke(),width:31},
    {...validStroke(),width:Infinity}, {...validStroke(),points:[]},
    {...validStroke(),points:[{x:201,y:20}]}, {...validStroke(),points:[{x:10,y:-1}]},
    {...validStroke(),points:[{x:NaN,y:10}]}, {...validStroke(),points:[null]}, null,
  ]) assert.throws(()=>validateInk([[bad]],[page]));
});

test('draft PDF base64 preserves binary bytes and rejects malformed input', () => {
  const bytes=Uint8Array.from([0,1,127,128,254,255]);
  assert.deepEqual(fromBase64(toBase64(bytes)),bytes);
  assert.throws(()=>fromBase64(null),/原文件/);
  assert.throws(()=>fromBase64('not a valid base64!!!'));
});

function readOperators(doc,pageIndex) {
  const contents=doc.getPage(pageIndex).node.Contents();
  const streams=contents instanceof lib.PDFArray
    ? Array.from({length:contents.size()},(_,i)=>contents.lookup(i)) : [contents];
  return streams.map(s=>Buffer.from(lib.decodePDFRawStream(s).decode()).toString('latin1')).join('\n');
}

test('PDF export preserves four rotated cropped pages and positions vector ink', async () => {
  const original=await lib.PDFDocument.create();
  for(const v of viewports) {
    const p=original.addPage([400,300]);p.setCropBox(40,30,200,100);p.setRotation(lib.degrees(v.rotation));
  }
  const bytes=await original.save();
  const ink=viewports.map(v=>[{color:'#0000ff',width:4,points:[v.p,v.q]}]);
  const output=await exportPdf(bytes,ink,viewports);
  const result=await lib.PDFDocument.load(output);
  assert.equal(result.getPageCount(),4);
  for(let i=0;i<4;i++) {
    assert.equal(result.getPage(i).getRotation().angle,viewports[i].rotation);
    assert.deepEqual(result.getPage(i).getCropBox(),{x:40,y:30,width:200,height:100});
    const ops=readOperators(result,i);
    assert.match(ops,/60 -50 m/);
    assert.match(ops,/80 -70 l/);
    assert.match(ops,/1 0 0 -1 0 0 cm/);
    assert.match(ops,/4 w/);
    assert.match(ops,/0 0 1 RG/);
  }
});

test('PDF export scales line width with viewport user units and supports dot strokes', async () => {
  const original=await lib.PDFDocument.create();original.addPage([400,300]);
  const output=await exportPdf(await original.save(), [[
    {color:'#000000',width:4,points:[{x:40,y:160},{x:80,y:120}]},
    {color:'#ff0000',width:4,points:[{x:40,y:160}]},
  ]], [{transform:[2,0,0,-2,-80,260]}]);
  const result=await lib.PDFDocument.load(output);
  assert.equal(result.getPageCount(),1);
  const ops=readOperators(result,0);
  assert.match(ops,/60 -50 m/);assert.match(ops,/80 -70 l/);assert.match(ops,/2 w/);
  assert.match(ops,/1 0 0 rg/);
  // The dot is centred at (60,50), radius 1 PDF unit: its leftmost vertex is (59,50).
  assert.match(ops,/59 50 m/);
});

test('PDF export refuses a page-count mismatch instead of silently losing answers', async () => {
  const original=await lib.PDFDocument.create();original.addPage([100,100]);
  await assert.rejects(exportPdf(await original.save(),[],[]),/页数不一致/);
});
