export const DEFAULT_PEN_SETTINGS=Object.freeze({color:'#202b35',width:1.6,penOnly:false});
const STORAGE_KEY='paper-pdf.pen-settings.v1';

export function normalizeHex(value) {
  if(typeof value!=='string')return null;
  const hex=value.trim().replace(/^#/,'').toLowerCase();
  if(/^[0-9a-f]{6}$/.test(hex))return `#${hex}`;
  if(/^[0-9a-f]{3}$/.test(hex))return `#${[...hex].map(c=>c+c).join('')}`;
  return null;
}

export function hexToRgb(color) {
  const hex=normalizeHex(color);
  if(!hex)return null;
  return {r:parseInt(hex.slice(1,3),16),g:parseInt(hex.slice(3,5),16),b:parseInt(hex.slice(5,7),16)};
}

export function rgbToHex(r,g,b) {
  const channels=[r,g,b];
  if(!channels.every(n=>Number.isInteger(n)&&n>=0&&n<=255))return null;
  return `#${channels.map(n=>n.toString(16).padStart(2,'0')).join('')}`;
}

function cleanSettings(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))return {...DEFAULT_PEN_SETTINGS};
  return {
    color:normalizeHex(value.color)||DEFAULT_PEN_SETTINGS.color,
    width:Number.isFinite(value.width)&&value.width>=0.7&&value.width<=6?Math.round(value.width*10)/10:DEFAULT_PEN_SETTINGS.width,
    penOnly:typeof value.penOnly==='boolean'?value.penOnly:DEFAULT_PEN_SETTINGS.penOnly,
  };
}

export function loadPenSettings(storage) {
  try {
    const value=JSON.parse(storage.getItem(STORAGE_KEY));
    return value?.version===1?cleanSettings(value):{...DEFAULT_PEN_SETTINGS};
  }catch{return {...DEFAULT_PEN_SETTINGS};}
}

export function savePenSettings(storage,value) {
  try {
    storage.setItem(STORAGE_KEY,JSON.stringify({version:1,...cleanSettings(value)}));
    return true;
  }catch{return false;}
}
