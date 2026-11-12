// Display coordinates are PDF.js scale=1 viewport units, independent of zoom/DPR.
export function toPdf(point, transform) {
  const [a, b, c, d, e, f] = transform;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-10) throw new Error('无效页面坐标');
  return { x: (d * (point.x - e) - c * (point.y - f)) / det,
    y: (-b * (point.x - e) + a * (point.y - f)) / det };
}
const fmt = n => Number(n.toFixed(4));
export function strokePath(points, map = p => p) {
  if (!points.length) return '';
  const p = points.map(map);
  let path = `M ${fmt(p[0].x)} ${fmt(p[0].y)}`;
  for (let i = 1; i < p.length - 1; i++) {
    path += ` Q ${fmt(p[i].x)} ${fmt(p[i].y)} ${fmt((p[i].x+p[i+1].x)/2)} ${fmt((p[i].y+p[i+1].y)/2)}`;
  }
  if (p.length > 1) path += ` L ${fmt(p.at(-1).x)} ${fmt(p.at(-1).y)}`;
  return path;
}
export function segmentDistance(p, a, b) {
  const dx=b.x-a.x, dy=b.y-a.y, denom=dx*dx+dy*dy;
  const t=denom ? Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/denom)) : 0;
  return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
}
const midpoint = (a,b) => ({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
function hitsQuadratic(point,start,control,end,limit,tolerance,depth=0) {
  // A quadratic stays within the convex hull of its three defining points.
  // Reject distant curves before subdividing; erasing remains cheap on long pages.
  if(point.x<Math.min(start.x,control.x,end.x)-limit ||
     point.x>Math.max(start.x,control.x,end.x)+limit ||
     point.y<Math.min(start.y,control.y,end.y)-limit ||
     point.y>Math.max(start.y,control.y,end.y)+limit)return false;
  const flatness=segmentDistance(control,start,end)/2;
  if(flatness<=tolerance || depth>=12) {
    // Include the approximation error so a visible stroke is never missed solely
    // because its flattened chord lies slightly outside the eraser's radius.
    return segmentDistance(point,start,end)<=limit+flatness;
  }
  const left=midpoint(start,control),right=midpoint(control,end),middle=midpoint(left,right);
  return hitsQuadratic(point,start,left,middle,limit,tolerance,depth+1) ||
    hitsQuadratic(point,middle,right,end,limit,tolerance,depth+1);
}
export function hitsStroke(point, stroke, radius) {
  const limit = radius + stroke.width/2;
  const points=stroke.points;
  if(!points.length)return false;
  if(points.length===1)return segmentDistance(point,points[0],points[0])<=limit;
  const tolerance=Math.min(.25,limit/8);
  let start=points[0];
  // Match strokePath's midpoint-smoothed Q segments, followed by its final L.
  for(let i=1;i<points.length-1;i++) {
    const end=midpoint(points[i],points[i+1]);
    if(hitsQuadratic(point,start,points[i],end,limit,tolerance))return true;
    start=end;
  }
  return segmentDistance(point,start,points.at(-1))<=limit;
}
export class History {
  constructor(limit=100) { this.undoStack=[]; this.redoStack=[]; this.limit=limit; }
  push(page,before,after) {
    this.undoStack.push({page,before,after});
    if(this.undoStack.length>this.limit)this.undoStack.shift();
    this.redoStack=[];
  }
  undo() { const a=this.undoStack.pop();if(a)this.redoStack.push(a);return a; }
  redo() { const a=this.redoStack.pop();if(a)this.undoStack.push(a);return a; }
}
export function validateInk(pages, metadata) {
  if(!Array.isArray(pages)||pages.length!==metadata.length)throw new Error('草稿页数与原 PDF 不符');
  let total=0;
  return pages.map((strokes,i)=>{
    if(!Array.isArray(strokes))throw new Error('草稿笔迹格式无效');
    return strokes.map(s=>{
      if(!s||!/^#[0-9a-f]{6}$/i.test(s.color)||!Number.isFinite(s.width)||s.width<0.1||s.width>30||!Array.isArray(s.points)||!s.points.length)throw new Error('草稿笔迹格式无效');
      total+=s.points.length;if(total>2000000)throw new Error('草稿笔迹过多，无法安全打开');
      const {width,height}=metadata[i];
      const points=s.points.map(p=>{
        if(!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<-.01||p.y<-.01||p.x>width+.01||p.y>height+.01)throw new Error('草稿笔迹超出页面范围');
        return {x:p.x,y:p.y};
      });
      return {color:s.color,width:s.width,points};
    });
  });
}
